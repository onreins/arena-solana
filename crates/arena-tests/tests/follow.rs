//! The follow program, run for real in litesvm with the SPL token program:
//! subscriptions split exactly, only paid and active follows count, and the
//! performance fee is charged only above the high-water mark.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{
    self,
    solana_program::program_pack::Pack,
    state::{Account as SplAccount, AccountState, Mint as SplMint},
};
use follow::{Follow, Settings, MONTH, SIZE_FIXED, SIZE_PERCENT};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::Instruction,
    program_option::COption,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

const T0: i64 = 1_800_000_000;
const USDC: u64 = 1_000_000;

fn so(name: &str) -> String {
    format!("{}/../../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR"))
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c = svm.get_sysvar::<Clock>();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
    svm.expire_blockhash();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, svm.latest_blockhash());
    svm.send_transaction(tx)
}

fn ok(res: TransactionResult) -> Vec<String> {
    match res {
        Ok(m) => m.logs,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

fn fails(res: TransactionResult, code: &str) {
    match res {
        Ok(m) => panic!("expected {code}, but it succeeded:\n{}", m.logs.join("\n")),
        Err(f) => {
            let logs = f.meta.logs.join("\n");
            assert!(logs.contains(code) || format!("{:?}", f.err).contains(code), "expected {code}:\n{logs}\n{:?}", f.err);
        }
    }
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

// ---------------------------------------------------------------- SPL token accounts, written directly

fn put_mint(svm: &mut LiteSVM) -> Pubkey {
    let mint = Pubkey::new_unique();
    let mut data = vec![0; SplMint::LEN];
    SplMint { mint_authority: COption::None, supply: 1_000_000_000 * USDC, decimals: 6, is_initialized: true, freeze_authority: COption::None }
        .pack_into_slice(&mut data);
    svm.set_account(mint, Account { lamports: 1_000_000_000, data, owner: spl_token::ID, executable: false, rent_epoch: 0 }).unwrap();
    mint
}

fn put_token(svm: &mut LiteSVM, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
    let addr = Pubkey::new_unique();
    let mut data = vec![0; SplAccount::LEN];
    SplAccount { mint: *mint, owner: *owner, amount, state: AccountState::Initialized, ..Default::default() }.pack_into_slice(&mut data);
    svm.set_account(addr, Account { lamports: 1_000_000_000, data, owner: spl_token::ID, executable: false, rent_epoch: 0 }).unwrap();
    addr
}

fn balance(svm: &LiteSVM, token: &Pubkey) -> u64 {
    SplAccount::unpack(&svm.get_account(token).unwrap().data).unwrap().amount
}

fn approve(svm: &mut LiteSVM, token: &Pubkey, owner: &Keypair, delegate: &Pubkey, amount: u64) {
    let ix = spl_token::instruction::approve(&spl_token::ID, token, delegate, &owner.pubkey(), &[], amount).unwrap();
    ok(send(svm, &[ix], &[owner]));
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    T::try_deserialize(&mut svm.get_account(address).unwrap().data.as_slice()).unwrap()
}

// ---------------------------------------------------------------- the program's instructions

fn config_of(admin: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"config", admin.as_ref()], &follow::ID).0
}
fn plan_of(config: &Pubkey, agent: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"plan", config.as_ref(), agent.as_ref()], &follow::ID).0
}
fn follow_of(plan: &Pubkey, follower: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"follow", plan.as_ref(), follower.as_ref()], &follow::ID).0
}

fn settings() -> Settings {
    Settings { size_mode: SIZE_FIXED, size_value: 100 * USDC, max_trade: 250 * USDC, max_open: 3, daily_loss_cap: 50 * USDC }
}

/// A world: Reins (admin + treasury), one agent with a plan, one follower holding USDC.
struct World {
    svm: LiteSVM,
    admin: Keypair,
    agent: Keypair,
    follower: Keypair,
    config: Pubkey,
    plan: Pubkey,
    follow: Pubkey,
    treasury: Pubkey,
    payout: Pubkey,
    follower_token: Pubkey,
}

const REINS_BPS: u16 = 2_000; // 20% of subscriptions
const PERF_REINS_BPS: u16 = 3_000; // 30% of performance fees
const PRICE: u64 = 9_990_001; // an awkward price, so rounding shows
const PERF_FEE_BPS: u16 = 2_000; // the agent takes 20% of profit above the mark

fn world() -> World {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(follow::ID, so("follow")).expect("target/deploy/follow.so: run anchor build");
    set_time(&mut svm, T0);
    let admin = funded(&mut svm);
    let agent = funded(&mut svm);
    let follower = funded(&mut svm);
    let mint = put_mint(&mut svm);
    let treasury = put_token(&mut svm, &mint, &admin.pubkey(), 0);
    let payout = put_token(&mut svm, &mint, &agent.pubkey(), 0);
    let follower_token = put_token(&mut svm, &mint, &follower.pubkey(), 1_000 * USDC);
    let config = config_of(&admin.pubkey());
    ok(send(&mut svm, &[Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::InitConfig { admin: admin.pubkey(), mint, treasury, config, system_program: system_program::ID }.to_account_metas(None),
        data: follow::instruction::InitConfig { reins_bps: REINS_BPS, perf_reins_bps: PERF_REINS_BPS }.data(),
    }], &[&admin]));
    let plan = plan_of(&config, &agent.pubkey());
    let mut w = World { svm, admin, agent, follower, config, plan, follow: Pubkey::default(), treasury, payout, follower_token };
    ok(set_plan(&mut w, PRICE, PERF_FEE_BPS, true));
    w.follow = follow_of(&w.plan, &w.follower.pubkey());
    w
}

fn set_plan(w: &mut World, price: u64, perf_fee_bps: u16, open: bool) -> TransactionResult {
    let ix = Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::SetPlan {
            agent: w.agent.pubkey(),
            payer: w.agent.pubkey(),
            config: w.config,
            payout: w.payout,
            plan: w.plan,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: follow::instruction::SetPlan { price, perf_fee_bps, open }.data(),
    };
    send(&mut w.svm, &[ix], &[&w.agent])
}

fn subscribe_ix(w: &World, months: u8, s: Settings) -> Instruction {
    Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::Subscribe {
            follower: w.follower.pubkey(),
            config: w.config,
            plan: w.plan,
            follow: w.follow,
            follower_token: w.follower_token,
            payout: w.payout,
            treasury: w.treasury,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: follow::instruction::Subscribe { months, settings: s }.data(),
    }
}

fn subscribe(w: &mut World, months: u8) -> TransactionResult {
    let ix = subscribe_ix(w, months, settings());
    send(&mut w.svm, &[ix], &[&w.follower])
}

fn settle_ix(w: &World, settler: &Pubkey, pnl: i64) -> Instruction {
    Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::SettlePerformance {
            admin: *settler,
            config: w.config,
            plan: w.plan,
            follow: w.follow,
            follower_token: w.follower_token,
            payout: w.payout,
            treasury: w.treasury,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: follow::instruction::SettlePerformance { pnl, report_hash: [4; 32] }.data(),
    }
}

fn settle(w: &mut World, pnl: i64) -> TransactionResult {
    let ix = settle_ix(w, &w.admin.pubkey(), pnl);
    send(&mut w.svm, &[ix], &[&w.admin])
}

/// The copier's rule: it trades only for a follow that is active and paid up.
fn copyable(f: &Follow, now: i64) -> bool {
    f.active && f.paid_until > now
}

// ---------------------------------------------------------------- subscriptions

#[test]
fn the_subscription_split_is_exact() {
    let mut w = world();
    ok(subscribe(&mut w, 3));
    let total = PRICE * 3; // 29_970_003
    let reins = total * REINS_BPS as u64 / 10_000; // 5_994_000 (floor)
    assert_eq!(balance(&w.svm, &w.treasury), reins);
    assert_eq!(balance(&w.svm, &w.payout), total - reins);
    assert_eq!(balance(&w.svm, &w.treasury) + balance(&w.svm, &w.payout), total, "nothing lost to rounding");
    assert_eq!(balance(&w.svm, &w.follower_token), 1_000 * USDC - total);

    let f: Follow = load(&w.svm, &w.follow);
    assert_eq!(f.paid_until, T0 + 3 * MONTH);
    assert_eq!(f.total_paid, total);
    assert!(copyable(&f, T0));
    assert_eq!(f.settings, settings());
}

#[test]
fn paid_time_extends_from_the_later_of_now_and_paid_until() {
    let mut w = world();
    ok(subscribe(&mut w, 1));
    set_time(&mut w.svm, T0 + 10 * 86_400);
    ok(subscribe(&mut w, 1)); // still paid: extends the paid period
    assert_eq!(load::<Follow>(&w.svm, &w.follow).paid_until, T0 + 2 * MONTH);
    set_time(&mut w.svm, T0 + 5 * MONTH);
    assert!(!copyable(&load::<Follow>(&w.svm, &w.follow), T0 + 5 * MONTH), "lapsed: the copier refuses it");
    ok(subscribe(&mut w, 1)); // lapsed: starts again from now
    assert_eq!(load::<Follow>(&w.svm, &w.follow).paid_until, T0 + 6 * MONTH);
}

#[test]
fn an_unpaid_or_stopped_follow_is_not_copied() {
    let mut w = world();
    assert!(w.svm.get_account(&w.follow).is_none(), "never subscribed: no Follow account at all");
    ok(subscribe(&mut w, 1));
    let stop = Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::FollowerOnly { follower: w.follower.pubkey(), follow: w.follow }.to_account_metas(None),
        data: follow::instruction::Stop {}.data(),
    };
    ok(send(&mut w.svm, &[stop], &[&w.follower]));
    let f: Follow = load(&w.svm, &w.follow);
    assert!(!copyable(&f, T0));
    assert_eq!(f.paid_until, T0 + MONTH, "stopping keeps the paid time");
    ok(subscribe(&mut w, 1)); // resumes
    assert!(copyable(&load::<Follow>(&w.svm, &w.follow), T0));
}

#[test]
fn subscriptions_refuse_bad_input() {
    let mut w = world();
    fails(subscribe(&mut w, 0), "BadMonths");
    fails(subscribe(&mut w, 13), "BadMonths");
    let bad = [
        Settings { size_mode: 2, ..settings() },
        Settings { size_value: 0, ..settings() },
        Settings { size_mode: SIZE_PERCENT, size_value: 10_001, ..settings() },
        Settings { max_open: 0, ..settings() },
        Settings { max_open: 11, ..settings() },
        Settings { max_trade: 0, ..settings() },
        Settings { daily_loss_cap: 0, ..settings() },
    ];
    for s in bad {
        let ix = subscribe_ix(&w, 1, s);
        fails(send(&mut w.svm, &[ix], &[&w.follower]), "BadSettings");
    }
    ok(set_plan(&mut w, PRICE, PERF_FEE_BPS, false));
    fails(subscribe(&mut w, 1), "PlanClosed");
}

#[test]
fn payments_go_only_to_the_plans_payout_and_the_treasury() {
    let mut w = world();
    let thief = funded(&mut w.svm);
    let mint = SplAccount::unpack(&w.svm.get_account(&w.payout).unwrap().data).unwrap().mint;
    let stash = put_token(&mut w.svm, &mint, &thief.pubkey(), 0);
    let mut ix = subscribe_ix(&w, 1, settings());
    ix.accounts[5].pubkey = stash; // payout
    fails(send(&mut w.svm, &[ix], &[&w.follower]), "ConstraintHasOne");
    let mut ix = subscribe_ix(&w, 1, settings());
    ix.accounts[6].pubkey = stash; // treasury
    fails(send(&mut w.svm, &[ix], &[&w.follower]), "ConstraintAddress");
    assert_eq!(balance(&w.svm, &stash), 0);
}

#[test]
fn only_the_follower_changes_or_stops_their_follow() {
    let mut w = world();
    ok(subscribe(&mut w, 1));
    let other = funded(&mut w.svm);
    let stop = Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::FollowerOnly { follower: other.pubkey(), follow: w.follow }.to_account_metas(None),
        data: follow::instruction::Stop {}.data(),
    };
    fails(send(&mut w.svm, &[stop], &[&other]), "ConstraintSeeds");
    let change = Instruction {
        program_id: follow::ID,
        accounts: follow::accounts::FollowerOnly { follower: w.follower.pubkey(), follow: w.follow }.to_account_metas(None),
        data: follow::instruction::UpdateSettings { settings: Settings { max_open: 5, ..settings() } }.data(),
    };
    ok(send(&mut w.svm, &[change], &[&w.follower]));
    assert_eq!(load::<Follow>(&w.svm, &w.follow).settings.max_open, 5);
}

// ---------------------------------------------------------------- performance fees

#[test]
fn the_performance_fee_is_charged_only_above_the_high_water_mark() {
    let mut w = world();
    ok(subscribe(&mut w, 1));
    let (fw, ft) = (w.follow, w.follower_token);
    let follower = w.follower.insecure_clone();
    approve(&mut w.svm, &ft, &follower, &fw, 100 * USDC);
    let start_t = balance(&w.svm, &w.treasury);
    let start_p = balance(&w.svm, &w.payout);
    let start_f = balance(&w.svm, &w.follower_token);

    ok(settle(&mut w, 40 * USDC as i64)); // first: sets the mark, no fee
    assert_eq!(balance(&w.svm, &w.follower_token), start_f);
    let f: Follow = load(&w.svm, &w.follow);
    assert!(f.hwm_set);
    assert_eq!(f.hwm, 40 * USDC as i64);

    ok(settle(&mut w, 25 * USDC as i64)); // a drawdown: no fee, the mark holds
    ok(settle(&mut w, 40 * USDC as i64)); // back to the mark: still no fee
    assert_eq!(balance(&w.svm, &w.follower_token), start_f);
    assert_eq!(load::<Follow>(&w.svm, &w.follow).hwm, 40 * USDC as i64);

    ok(settle(&mut w, 90 * USDC as i64)); // 50 USDC above the mark
    let fee = 50 * USDC * PERF_FEE_BPS as u64 / 10_000; // 10 USDC
    let reins = fee * PERF_REINS_BPS as u64 / 10_000; // 3 USDC
    assert_eq!(balance(&w.svm, &w.follower_token), start_f - fee);
    assert_eq!(balance(&w.svm, &w.treasury) - start_t, reins);
    assert_eq!(balance(&w.svm, &w.payout) - start_p, fee - reins);
    let f: Follow = load(&w.svm, &w.follow);
    assert_eq!((f.hwm, f.perf_fees_paid, f.settlements), (90 * USDC as i64, fee, 4));

    ok(settle(&mut w, 60 * USDC as i64)); // below the new mark: nothing
    assert_eq!(balance(&w.svm, &w.follower_token), start_f - fee);
}

#[test]
fn only_the_configs_settler_settles_and_never_beyond_the_allowance() {
    let mut w = world();
    ok(subscribe(&mut w, 1));
    let (fw, ft) = (w.follow, w.follower_token);
    let follower = w.follower.insecure_clone();
    approve(&mut w.svm, &ft, &follower, &fw, USDC); // 1 USDC allowance
    ok(settle(&mut w, 0));

    let impostor = funded(&mut w.svm);
    let ix = settle_ix(&w, &impostor.pubkey(), 1_000 * USDC as i64);
    fails(send(&mut w.svm, &[ix], &[&impostor]), "ConstraintHasOne");

    // a 2 USDC fee against a 1 USDC allowance: the token program refuses, nothing moves
    let before = balance(&w.svm, &w.follower_token);
    fails(settle(&mut w, 10 * USDC as i64), "insufficient funds");
    assert_eq!(balance(&w.svm, &w.follower_token), before);
    assert_eq!(load::<Follow>(&w.svm, &w.follow).hwm, 0, "a failed settlement leaves the mark alone");

    // the follower revokes the allowance: no fee can be taken at all
    let revoke = spl_token::instruction::revoke(&spl_token::ID, &ft, &follower.pubkey(), &[]).unwrap();
    ok(send(&mut w.svm, &[revoke], &[&follower]));
    fails(settle(&mut w, 5 * USDC as i64), "owner does not match");
}
