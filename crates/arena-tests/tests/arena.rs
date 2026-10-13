//! The Arena program, run for real in litesvm from its built .so (`anchor
//! build` first): every rule the program promises.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use arena::{call_hash, Book, Call, Profile, Score, ScoreArgs, GRACE};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_sdk::{
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};

const T0: i64 = 1_800_000_000; // a whole minute
const SCORING: [u8; 16] = *b"arena-v1\0\0\0\0\0\0\0\0";

fn so(name: &str) -> String {
    format!("{}/../../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR"))
}

fn setup() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(arena::ID, so("arena")).expect("target/deploy/arena.so: run anchor build");
    svm.add_program_from_file(score_gate::ID, so("score_gate")).expect("target/deploy/score_gate.so: run anchor build");
    set_time(&mut svm, T0);
    svm
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c = svm.get_sysvar::<Clock>();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionResult {
    svm.expire_blockhash(); // a repeated transaction would otherwise be a duplicate signature
    let tx = Transaction::new_signed_with_payer(ixs, Some(&signers[0].pubkey()), signers, svm.latest_blockhash());
    svm.send_transaction(tx)
}

fn ok(res: TransactionResult) -> Vec<String> {
    match res {
        Ok(m) => m.logs,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

/// It failed, and its logs name `code`.
fn fails(res: TransactionResult, code: &str) {
    match res {
        Ok(m) => panic!("expected {code}, but it succeeded:\n{}", m.logs.join("\n")),
        Err(f) => {
            let logs = f.meta.logs.join("\n");
            assert!(logs.contains(code) || format!("{:?}", f.err).contains(code), "expected {code}:\n{logs}\n{:?}", f.err);
        }
    }
}

fn load<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> Option<T> {
    svm.get_account(address).map(|a| T::try_deserialize(&mut a.data.as_slice()).unwrap())
}

fn book_of(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"book", owner.as_ref()], &arena::ID).0
}
fn call_of(book: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"call", book.as_ref(), &id.to_le_bytes()], &arena::ID).0
}
fn profile_of(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"profile", owner.as_ref()], &arena::ID).0
}
fn score_of(validator: &Pubkey, book: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"score", validator.as_ref(), book.as_ref()], &arena::ID).0
}

/// Names of the Arena events in a transaction's logs, in order.
fn events(logs: &[String]) -> Vec<&'static str> {
    use anchor_lang::Discriminator;
    use base64::Engine;
    let names: [(&[u8], &'static str); 5] = [
        (arena::BookOpened::DISCRIMINATOR, "BookOpened"),
        (arena::Locked::DISCRIMINATOR, "Locked"),
        (arena::Revealed::DISCRIMINATOR, "Revealed"),
        (arena::ProfileSet::DISCRIMINATOR, "ProfileSet"),
        (arena::ScoreWritten::DISCRIMINATOR, "ScoreWritten"),
    ];
    logs.iter()
        .filter_map(|l| l.strip_prefix("Program data: "))
        .filter_map(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .filter_map(|d| names.iter().find(|(disc, _)| d.starts_with(disc)).map(|(_, n)| *n))
        .collect()
}

/// The Revealed event's salt, decoded from the logs.
fn revealed_salt(logs: &[String]) -> [u8; 32] {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    use base64::Engine;
    for l in logs {
        if let Some(b) = l.strip_prefix("Program data: ") {
            let d = base64::engine::general_purpose::STANDARD.decode(b).unwrap();
            if d.starts_with(arena::Revealed::DISCRIMINATOR) {
                return arena::Revealed::deserialize(&mut &d[8..]).unwrap().salt;
            }
        }
    }
    panic!("no Revealed event");
}

struct Locked {
    book: Pubkey,
    call_id: u64,
    coin: String,
    side: i8,
    horizon: u32,
    salt: [u8; 32],
}

fn lock_ix(owner: &Pubkey, payer: &Pubkey, call_id: u64, hash: [u8; 32], horizon: u32) -> Instruction {
    let book = book_of(owner);
    Instruction {
        program_id: arena::ID,
        accounts: arena::accounts::Lock {
            owner: *owner,
            payer: *payer,
            book,
            call: call_of(&book, call_id),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: arena::instruction::Lock { call_id, call_hash: hash, horizon }.data(),
    }
}

fn reveal_ix(revealer: &Pubkey, owner: &Pubkey, call_id: u64, coin: &str, side: i8, salt: [u8; 32]) -> Instruction {
    let book = book_of(owner);
    Instruction {
        program_id: arena::ID,
        accounts: arena::accounts::Reveal { revealer: *revealer, book, call: call_of(&book, call_id) }.to_account_metas(None),
        data: arena::instruction::Reveal { coin: coin.to_string(), side, salt }.data(),
    }
}

fn salt() -> [u8; 32] {
    Keypair::new().pubkey().to_bytes()
}

struct LockOpts<'a> {
    payer: Option<&'a Keypair>,
    coin: &'a str,
    side: i8,
    horizon: u32,
    call_id: Option<u64>,
    salt: Option<[u8; 32]>,
}
impl Default for LockOpts<'_> {
    fn default() -> Self {
        LockOpts { payer: None, coin: "SOL", side: 1, horizon: 3600, call_id: None, salt: None }
    }
}

fn lock(svm: &mut LiteSVM, owner: &Keypair, o: LockOpts) -> (TransactionResult, Locked) {
    let book = book_of(&owner.pubkey());
    let id = o.call_id.unwrap_or_else(|| load::<Book>(svm, &book).map(|b| b.lock_count).unwrap_or(0));
    let s = o.salt.unwrap_or_else(salt);
    let hash = call_hash(&arena::ID, &book, id, o.horizon, o.coin.as_bytes(), o.side, &s);
    let payer = o.payer.unwrap_or(owner);
    let ix = lock_ix(&owner.pubkey(), &payer.pubkey(), id, hash, o.horizon);
    let res = if payer.pubkey() == owner.pubkey() { send(svm, &[ix], &[owner]) } else { send(svm, &[ix], &[payer, owner]) };
    (res, Locked { book, call_id: id, coin: o.coin.into(), side: o.side, horizon: o.horizon, salt: s })
}

fn reveal(svm: &mut LiteSVM, by: &Keypair, owner: &Pubkey, c: &Locked) -> TransactionResult {
    send(svm, &[reveal_ix(&by.pubkey(), owner, c.call_id, &c.coin, c.side, c.salt)], &[by])
}

// ---------------------------------------------------------------- the hash

#[test]
fn call_hash_matches_the_js_vector() {
    // solana/test/arena-codec.test.js asserts the same bytes from solana/arena.js
    let h = call_hash(&arena::ID, &Pubkey::new_from_array([1; 32]), 7, 3600, b"BTC", -1, &[2; 32]);
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "742431a25e1d7f60dfd582b99bcb68f79a0be89329e61d2a80f504a39cc5a683");
}

// ---------------------------------------------------------------- locks

#[test]
fn a_lock_opens_the_book_and_takes_its_times_from_the_clock() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    set_time(&mut svm, T0 + 7);
    let (res, c) = lock(&mut svm, &owner, LockOpts::default());
    assert_eq!(events(&ok(res)), ["BookOpened", "Locked"]);

    let book: Book = load(&svm, &c.book).unwrap();
    assert_eq!((book.owner, book.lock_count, book.opened_at), (owner.pubkey(), 1, T0 + 7));
    let call: Call = load(&svm, &call_of(&c.book, 0)).unwrap();
    assert_eq!(call.locked_at, T0 + 7);
    // the first whole minute at least SEAL_LEAD (60s) after the lock
    assert_eq!(call.entry_at, T0 + 120);
    assert_eq!(call.horizon, 3600);
    assert!(!call.revealed);
}

#[test]
fn no_backdating_entry_always_follows_the_clock() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    set_time(&mut svm, T0 + 60); // on a minute: entry is exactly SEAL_LEAD later
    ok(lock(&mut svm, &owner, LockOpts::default()).0);
    set_time(&mut svm, T0 + 3601);
    ok(lock(&mut svm, &owner, LockOpts::default()).0);
    let book = book_of(&owner.pubkey());
    assert_eq!(load::<Call>(&svm, &call_of(&book, 0)).unwrap().entry_at, T0 + 120);
    assert_eq!(load::<Call>(&svm, &call_of(&book, 1)).unwrap().entry_at, T0 + 3600 + 120);
    // the instruction carries no time at all: discriminator, call id, hash, horizon
    let data = arena::instruction::Lock { call_id: 0, call_hash: [1; 32], horizon: 300 }.data();
    assert_eq!(data.len(), 8 + 8 + 32 + 4);
}

#[test]
fn locks_refuse_stale_ids_bad_horizons_and_empty_hashes() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    ok(lock(&mut svm, &owner, LockOpts::default()).0);
    fails(lock(&mut svm, &owner, LockOpts { call_id: Some(0), ..Default::default() }).0, "already in use");
    fails(lock(&mut svm, &owner, LockOpts { call_id: Some(2), ..Default::default() }).0, "StaleId");
    for h in [240, 299, 330, 30 * 86_400 + 60] {
        fails(lock(&mut svm, &owner, LockOpts { horizon: h, ..Default::default() }).0, "BadHorizon");
    }
    ok(lock(&mut svm, &owner, LockOpts { horizon: 30 * 86_400, ..Default::default() }).0);
    ok(lock(&mut svm, &owner, LockOpts { horizon: 300, ..Default::default() }).0);
    let ix = lock_ix(&owner.pubkey(), &owner.pubkey(), 3, [0; 32], 300);
    fails(send(&mut svm, &[ix], &[&owner]), "EmptyCall");
}

#[test]
fn a_relayer_pays_while_the_owner_holding_no_sol_signs() {
    let mut svm = setup();
    let relayer = funded(&mut svm);
    let owner = Keypair::new(); // never funded
    let before = svm.get_balance(&relayer.pubkey()).unwrap();
    ok(lock(&mut svm, &owner, LockOpts { payer: Some(&relayer), ..Default::default() }).0);
    assert_eq!(svm.get_balance(&owner.pubkey()).unwrap_or(0), 0);
    assert!(svm.get_balance(&relayer.pubkey()).unwrap() < before);
    assert_eq!(load::<Book>(&svm, &book_of(&owner.pubkey())).unwrap().owner, owner.pubkey());
}

#[test]
fn nobody_locks_into_a_book_without_its_owners_signature() {
    let mut svm = setup();
    let victim = Keypair::new();
    let attacker = funded(&mut svm);
    let mut ix = lock_ix(&victim.pubkey(), &attacker.pubkey(), 0, [9; 32], 300);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == victim.pubkey() {
            m.is_signer = false;
        }
    }
    fails(send(&mut svm, &[ix], &[&attacker]), "AccountNotSigner");
    assert!(svm.get_account(&book_of(&victim.pubkey())).is_none());
}

// ---------------------------------------------------------------- reveals

#[test]
fn the_commitment_binds_every_field() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    let other = funded(&mut svm);
    let by = funded(&mut svm);
    let (res, c) = lock(&mut svm, &owner, LockOpts { coin: "BTC", side: -1, horizon: 600, ..Default::default() });
    ok(res);
    // another book's call 0 with the very same preimage: the book is in the hash
    let (res, o) = lock(&mut svm, &other, LockOpts { coin: "BTC", side: -1, horizon: 600, salt: Some(c.salt), ..Default::default() });
    ok(res);
    let ha = load::<Call>(&svm, &call_of(&c.book, 0)).unwrap().call_hash;
    let hb = load::<Call>(&svm, &call_of(&o.book, 0)).unwrap().call_hash;
    assert_ne!(ha, hb);

    set_time(&mut svm, T0 + 120 + 600);
    let o_pk = owner.pubkey();
    let try_reveal = |svm: &mut LiteSVM, coin: &str, side: i8, s: [u8; 32]| send(svm, &[reveal_ix(&by.pubkey(), &o_pk, 0, coin, side, s)], &[&by]);
    fails(try_reveal(&mut svm, "ETH", -1, c.salt), "WrongPreimage");
    fails(try_reveal(&mut svm, "BTC\0", -1, c.salt), "WrongPreimage"); // the length is bound, not just padded bytes
    fails(try_reveal(&mut svm, "BTC", 1, c.salt), "WrongPreimage");
    fails(try_reveal(&mut svm, "BTC", -1, salt()), "WrongPreimage");
    fails(try_reveal(&mut svm, "", -1, c.salt), "BadCoin");
    fails(try_reveal(&mut svm, &"X".repeat(17), -1, c.salt), "BadCoin");
    fails(try_reveal(&mut svm, "BTC", 0, c.salt), "BadSide");
    // revealing book B's call through book A's account fails the address checks
    let mut cross = reveal_ix(&by.pubkey(), &o_pk, 0, "BTC", -1, c.salt);
    cross.accounts[2] = AccountMeta::new(call_of(&o.book, 0), false);
    fails(send(&mut svm, &[cross], &[&by]), "ConstraintSeeds");

    // the true preimage, revealed by a stranger: revealing is permissionless
    let logs = ok(try_reveal(&mut svm, "BTC", -1, c.salt));
    assert_eq!(events(&logs), ["Revealed"]);
    assert_eq!(revealed_salt(&logs), c.salt, "the event carries the salt");
    let call: Call = load(&svm, &call_of(&c.book, 0)).unwrap();
    assert!(call.revealed);
    assert_eq!((&call.coin[..call.coin_len as usize], call.side), (&b"BTC"[..], -1));
}

#[test]
fn a_hash_made_for_another_call_id_or_horizon_never_reveals() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    let book = book_of(&owner.pubkey());
    let s = salt();
    let wrong_id = call_hash(&arena::ID, &book, 1, 600, b"SOL", 1, &s);
    ok(send(&mut svm, &[lock_ix(&owner.pubkey(), &owner.pubkey(), 0, wrong_id, 600)], &[&owner]));
    let wrong_horizon = call_hash(&arena::ID, &book, 1, 300, b"SOL", 1, &s);
    ok(send(&mut svm, &[lock_ix(&owner.pubkey(), &owner.pubkey(), 1, wrong_horizon, 600)], &[&owner]));
    set_time(&mut svm, T0 + 120 + 600);
    fails(send(&mut svm, &[reveal_ix(&owner.pubkey(), &owner.pubkey(), 0, "SOL", 1, s)], &[&owner]), "WrongPreimage");
    fails(send(&mut svm, &[reveal_ix(&owner.pubkey(), &owner.pubkey(), 1, "SOL", 1, s)], &[&owner]), "WrongPreimage");
}

#[test]
fn a_call_reveals_only_after_its_horizon_within_grace_and_once() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    let (res, c) = lock(&mut svm, &owner, LockOpts { horizon: 3600, ..Default::default() });
    ok(res);
    let exit_at = T0 + 60 + 3600; // T0 is a whole minute, so entry is exactly SEAL_LEAD later
    set_time(&mut svm, exit_at - 1);
    fails(reveal(&mut svm, &owner, &owner.pubkey(), &c), "RevealTooEarly");
    set_time(&mut svm, exit_at);
    ok(reveal(&mut svm, &owner, &owner.pubkey(), &c));
    fails(reveal(&mut svm, &owner, &owner.pubkey(), &c), "AlreadyRevealed");

    let (res, late) = lock(&mut svm, &owner, LockOpts { horizon: 300, ..Default::default() });
    ok(res);
    let late_exit = load::<Call>(&svm, &call_of(&late.book, late.call_id)).unwrap().entry_at + 300;
    set_time(&mut svm, late_exit + GRACE);
    ok(reveal(&mut svm, &owner, &owner.pubkey(), &late)); // the last second of GRACE still counts
}

#[test]
fn a_withheld_call_stays_withheld() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    let (res, c) = lock(&mut svm, &owner, LockOpts { horizon: 300, ..Default::default() });
    ok(res);
    set_time(&mut svm, T0 + 120 + 300 + GRACE + 1);
    fails(reveal(&mut svm, &owner, &owner.pubkey(), &c), "RevealExpired");
    let call: Call = load(&svm, &call_of(&c.book, 0)).unwrap();
    assert!(!call.revealed);
    assert_eq!(call.coin_len, 0);
}

// ---------------------------------------------------------------- profiles

fn profile_ix(owner: &Pubkey, payer: &Pubkey, name: &str, bio: &str, link: &str) -> Instruction {
    Instruction {
        program_id: arena::ID,
        accounts: arena::accounts::SetProfile { owner: *owner, payer: *payer, profile: profile_of(owner), system_program: system_program::ID }
            .to_account_metas(None),
        data: arena::instruction::SetProfile { name: name.into(), bio: bio.into(), link: link.into() }.data(),
    }
}

#[test]
fn profiles_keep_to_their_caps_and_the_newest_stands() {
    let mut svm = setup();
    let owner = funded(&mut svm);
    let relayer = funded(&mut svm);
    let (o, r) = (owner.pubkey(), relayer.pubkey());
    let mut set = |svm: &mut LiteSVM, n: &str, b: &str, l: &str| send(svm, &[profile_ix(&o, &r, n, b, l)], &[&relayer, &owner]);
    ok(set(&mut svm, &"N".repeat(32), &"B".repeat(160), &"L".repeat(100)));
    fails(set(&mut svm, &"N".repeat(33), "", ""), "ProfileTooLong");
    fails(set(&mut svm, "", &"B".repeat(161), ""), "ProfileTooLong");
    fails(set(&mut svm, "", "", &"L".repeat(101)), "ProfileTooLong");
    let logs = ok(set(&mut svm, "Hot list", "Momentum, 4h", "https://app.reins.one"));
    assert_eq!(events(&logs), ["ProfileSet"]);
    let p: Profile = load(&svm, &profile_of(&o)).unwrap();
    assert_eq!((p.name.as_str(), p.bio.as_str(), p.link.as_str()), ("Hot list", "Momentum, 4h", "https://app.reins.one"));
    ok(set(&mut svm, "", "", ""));
    assert_eq!(load::<Profile>(&svm, &profile_of(&o)).unwrap().name, "");
}

// ---------------------------------------------------------------- scores

fn args(score: u8) -> ScoreArgs {
    ScoreArgs { score, calls: 3, revealed: 2, withheld: 1, through_call: 3, report_hash: [5; 32], scoring: SCORING }
}

fn score_ix(validator: &Pubkey, payer: &Pubkey, owner: &Pubkey, a: ScoreArgs) -> Instruction {
    let book = book_of(owner);
    Instruction {
        program_id: arena::ID,
        accounts: arena::accounts::WriteScore {
            validator: *validator,
            payer: *payer,
            book,
            score: score_of(validator, &book),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: arena::instruction::WriteScore { args: a }.data(),
    }
}

fn scored_book(svm: &mut LiteSVM) -> Keypair {
    let agent = funded(svm);
    for _ in 0..3 {
        ok(lock(svm, &agent, LockOpts::default()).0);
    }
    agent
}

#[test]
fn the_validator_writes_a_score_per_book_and_rewrites_it() {
    let mut svm = setup();
    let agent = scored_book(&mut svm);
    let v = funded(&mut svm);
    let logs = ok(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), args(72))], &[&v]));
    assert_eq!(events(&logs), ["ScoreWritten"]);
    let addr = score_of(&v.pubkey(), &book_of(&agent.pubkey()));
    let s: Score = load(&svm, &addr).unwrap();
    assert_eq!((s.score, s.calls, s.revealed, s.withheld, s.through_call), (72, 3, 2, 1, 3));
    assert_eq!((s.owner, s.validator, s.scoring), (agent.pubkey(), v.pubkey(), SCORING));
    assert_eq!(svm.get_account(&addr).unwrap().data.len(), 183, "the documented, stable size");
    ok(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), args(40))], &[&v]));
    assert_eq!(load::<Score>(&svm, &addr).unwrap().score, 40);
}

#[test]
fn only_the_validator_named_in_its_address_can_write_it() {
    let mut svm = setup();
    let agent = scored_book(&mut svm);
    let v = funded(&mut svm);
    let impostor = funded(&mut svm);
    ok(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), args(72))], &[&v]));
    let target = score_of(&v.pubkey(), &book_of(&agent.pubkey()));

    // the impostor signs as itself but aims at the real validator's Score account
    let mut ix = score_ix(&impostor.pubkey(), &impostor.pubkey(), &agent.pubkey(), args(100));
    ix.accounts[3] = AccountMeta::new(target, false);
    fails(send(&mut svm, &[ix], &[&impostor]), "ConstraintSeeds");
    // or names the validator without its signature
    let mut ix = score_ix(&v.pubkey(), &impostor.pubkey(), &agent.pubkey(), args(100));
    ix.accounts[0].is_signer = false;
    fails(send(&mut svm, &[ix], &[&impostor]), "AccountNotSigner");
    assert_eq!(load::<Score>(&svm, &target).unwrap().score, 72);
}

#[test]
fn scores_and_counts_must_be_in_range() {
    let mut svm = setup();
    let agent = scored_book(&mut svm);
    let v = funded(&mut svm);
    let bad = [
        ScoreArgs { score: 101, ..args(0) },
        ScoreArgs { revealed: 3, withheld: 1, ..args(50) },
        ScoreArgs { through_call: 4, ..args(50) }, // only 3 calls locked
        ScoreArgs { calls: 3, through_call: 2, ..args(50) },
        ScoreArgs { scoring: [0; 16], ..args(50) },
    ];
    for a in bad {
        fails(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), a)], &[&v]), "BadScore");
    }
    ok(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), args(50))], &[&v]));
}

// ---------------------------------------------------------------- composing

fn admit_ix(agent: &Pubkey, score: &Pubkey, validator: Pubkey, min_score: u8, max_age_secs: i64) -> Instruction {
    Instruction {
        program_id: score_gate::ID,
        accounts: score_gate::accounts::Admit { agent: *agent, score: *score }.to_account_metas(None),
        data: score_gate::instruction::Admit { validator, min_score, max_age_secs }.data(),
    }
}

#[test]
fn another_program_gates_on_a_score_through_arena_score() {
    let mut svm = setup();
    let agent = scored_book(&mut svm);
    let v = funded(&mut svm);
    let caller = funded(&mut svm);
    ok(send(&mut svm, &[score_ix(&v.pubkey(), &v.pubkey(), &agent.pubkey(), args(72))], &[&v]));
    let score = score_of(&v.pubkey(), &book_of(&agent.pubkey()));
    let a = agent.pubkey();

    ok(send(&mut svm, &[admit_ix(&a, &score, v.pubkey(), 70, 0)], &[&caller]));
    fails(send(&mut svm, &[admit_ix(&a, &score, v.pubkey(), 73, 0)], &[&caller]), "ScoreTooLow");
    // arena-score's errors: 0x4152_0000 + WrongValidator (3) / WrongAgent (4) / WrongOwner (0)
    fails(send(&mut svm, &[admit_ix(&a, &score, caller.pubkey(), 0, 0)], &[&caller]), "0x41520003");
    fails(send(&mut svm, &[admit_ix(&caller.pubkey(), &score, v.pubkey(), 0, 0)], &[&caller]), "0x41520004");
    fails(send(&mut svm, &[admit_ix(&a, &book_of(&a), v.pubkey(), 0, 0)], &[&caller]), "0x41520001"); // a Book, not a Score
    fails(send(&mut svm, &[admit_ix(&a, &caller.pubkey(), v.pubkey(), 0, 0)], &[&caller]), "0x41520000");
    set_time(&mut svm, T0 + 3 * 86_400);
    fails(send(&mut svm, &[admit_ix(&a, &score, v.pubkey(), 70, 86_400)], &[&caller]), "ScoreStale");
    ok(send(&mut svm, &[admit_ix(&a, &score, v.pubkey(), 70, 0)], &[&caller]));
}
