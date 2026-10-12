//! Follow: subscriptions to AI trading agents on Solana, for Reins
//! copy-trading.
//!
//! An agent's owner sets a Plan: a monthly price in USDC and a performance fee
//! rate. A follower subscribes with a Follow account (one per follower and
//! agent) that holds how long they have paid for and their copy settings:
//! trade size and limits. Every payment is split at a fixed rate between the
//! agent's owner and the Reins treasury, in the same transaction. The copier
//! trades only for follows that are active and paid up.
//!
//! The performance fee is a share of a follower's copied profit, charged only
//! above their previous peak (a high-water mark). The profit is measured by
//! Reins off-chain, from the follower's dedicated copy subaccount on the perps
//! exchange, and reported by the settler named in the Config; the program
//! applies the high-water mark, splits the fee and records every settlement.
//! The fee is collected from an allowance the follower grants to their own
//! Follow account on their USDC account, so it can never exceed what they
//! approved, and they can revoke the allowance at any time.
//!
//! Nothing here can touch a follower's trading account: copying runs through
//! the exchange's delegate, which can trade but never withdraw.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("A5Zpb539Yazb3kypH7tvZBVWuGCdCwXU6sdVU8RkgJHC");

/// One paid month.
pub const MONTH: i64 = 30 * 86_400;
pub const MAX_MONTHS: u8 = 12;
pub const BPS: u64 = 10_000;
/// No split or fee rate may exceed half.
pub const MAX_RATE_BPS: u16 = 5_000;
/// Each copied call uses three order slots (entry, take-profit, stop-loss)
/// of the exchange's 32 per account.
pub const MAX_OPEN_COPIED: u8 = 10;

pub const SIZE_FIXED: u8 = 0;
pub const SIZE_PERCENT: u8 = 1;

pub const CONFIG_SEED: &[u8] = b"config";
pub const PLAN_SEED: &[u8] = b"plan";
pub const FOLLOW_SEED: &[u8] = b"follow";

#[program]
pub mod follow {
    use super::*;

    /// Set up a fee schedule, at ["config", admin]. The admin is also the
    /// settler of performance fees. Anyone can make a config of their own;
    /// Reins' is the one under Reins' admin key.
    pub fn init_config(ctx: Context<InitConfig>, reins_bps: u16, perf_reins_bps: u16) -> Result<()> {
        require!(reins_bps <= MAX_RATE_BPS && perf_reins_bps <= MAX_RATE_BPS, FollowError::BadRate);
        let c = &mut ctx.accounts.config;
        c.version = 1;
        c.bump = ctx.bumps.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = ctx.accounts.mint.key();
        c.treasury = ctx.accounts.treasury.key();
        c.reins_bps = reins_bps;
        c.perf_reins_bps = perf_reins_bps;
        emit!(ConfigSet { config: c.key(), admin: c.admin, mint: c.mint, treasury: c.treasury, reins_bps, perf_reins_bps });
        Ok(())
    }

    /// The agent's owner sets (or changes) its plan: the monthly price, the
    /// performance fee rate, where its share is paid, and whether new
    /// subscriptions are open. A price change applies to the next payment.
    pub fn set_plan(ctx: Context<SetPlan>, price: u64, perf_fee_bps: u16, open: bool) -> Result<()> {
        require!(perf_fee_bps <= MAX_RATE_BPS, FollowError::BadRate);
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.plan;
        if p.agent == Pubkey::default() {
            p.version = 1;
            p.bump = ctx.bumps.plan;
            p.config = ctx.accounts.config.key();
            p.agent = ctx.accounts.agent.key();
            p.created_at = now;
        }
        p.payout = ctx.accounts.payout.key();
        p.price = price;
        p.perf_fee_bps = perf_fee_bps;
        p.open = open;
        emit!(PlanSet { plan: p.key(), agent: p.agent, payout: p.payout, price, perf_fee_bps, open });
        Ok(())
    }

    /// Pay for `months` and set the copy settings. The payment is split
    /// between the agent's owner and the treasury here and now; paid time
    /// extends from the later of now and the current paid-until.
    pub fn subscribe(ctx: Context<Subscribe>, months: u8, settings: Settings) -> Result<()> {
        require!((1..=MAX_MONTHS).contains(&months), FollowError::BadMonths);
        settings.check()?;
        let plan = &ctx.accounts.plan;
        require!(plan.open, FollowError::PlanClosed);
        let config = &ctx.accounts.config;

        let total = plan.price.checked_mul(months as u64).ok_or(FollowError::Overflow)?;
        let (agent_part, reins_part) = split(total, config.reins_bps)?;
        let auth = ctx.accounts.follower.to_account_info();
        pay(&ctx.accounts.token_program, &ctx.accounts.follower_token, &ctx.accounts.payout, &auth, agent_part, None)?;
        pay(&ctx.accounts.token_program, &ctx.accounts.follower_token, &ctx.accounts.treasury, &auth, reins_part, None)?;

        let now = Clock::get()?.unix_timestamp;
        let f = &mut ctx.accounts.follow;
        if f.follower == Pubkey::default() {
            f.version = 1;
            f.bump = ctx.bumps.follow;
            f.plan = plan.key();
            f.follower = ctx.accounts.follower.key();
            f.created_at = now;
        }
        f.paid_until = f.paid_until.max(now).checked_add(MONTH * months as i64).ok_or(FollowError::Overflow)?;
        f.active = true;
        f.settings = settings.clone();
        f.total_paid = f.total_paid.checked_add(total).ok_or(FollowError::Overflow)?;

        emit!(Subscribed {
            follow: f.key(),
            plan: plan.key(),
            follower: f.follower,
            months,
            total,
            agent_part,
            reins_part,
            paid_until: f.paid_until,
            settings,
        });
        Ok(())
    }

    /// Change size and limits without paying.
    pub fn update_settings(ctx: Context<FollowerOnly>, settings: Settings) -> Result<()> {
        settings.check()?;
        let f = &mut ctx.accounts.follow;
        f.settings = settings.clone();
        emit!(SettingsChanged { follow: f.key(), settings });
        Ok(())
    }

    /// Stop copying now. Paid time is kept; subscribing again resumes.
    pub fn stop(ctx: Context<FollowerOnly>) -> Result<()> {
        let f = &mut ctx.accounts.follow;
        f.active = false;
        emit!(Stopped { follow: f.key(), follower: f.follower });
        Ok(())
    }

    /// Record a performance-fee settlement. `pnl` is the follower's copy
    /// subaccount's all-time PnL in the quote's smallest unit, as measured by
    /// the settler. The first settlement only sets the high-water mark; after
    /// that, a fee is charged on the gain above it, split between the agent's
    /// owner and the treasury, and the mark rises.
    pub fn settle_performance(ctx: Context<SettlePerformance>, pnl: i64, report_hash: [u8; 32]) -> Result<()> {
        let plan = &ctx.accounts.plan;
        let config = &ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        let f = &ctx.accounts.follow;
        let hwm_before = f.hwm;
        let (fee, hwm_after) = performance_fee(f.hwm_set, f.hwm, pnl, plan.perf_fee_bps)?;
        let (agent_part, reins_part) = split(fee, config.perf_reins_bps)?;

        // The Follow account is the delegate the follower approved on their USDC account.
        let plan_key = plan.key();
        let follower_key = f.follower;
        let seeds: &[&[u8]] = &[FOLLOW_SEED, plan_key.as_ref(), follower_key.as_ref(), &[f.bump]];
        let auth = ctx.accounts.follow.to_account_info();
        pay(&ctx.accounts.token_program, &ctx.accounts.follower_token, &ctx.accounts.payout, &auth, agent_part, Some(seeds))?;
        pay(&ctx.accounts.token_program, &ctx.accounts.follower_token, &ctx.accounts.treasury, &auth, reins_part, Some(seeds))?;

        let f = &mut ctx.accounts.follow;
        f.hwm_set = true;
        f.hwm = hwm_after;
        f.perf_fees_paid = f.perf_fees_paid.checked_add(fee).ok_or(FollowError::Overflow)?;
        f.settlements = f.settlements.checked_add(1).ok_or(FollowError::Overflow)?;
        f.last_settled_at = now;

        emit!(PerformanceSettled {
            follow: f.key(),
            follower: f.follower,
            pnl,
            hwm_before,
            hwm_after,
            fee,
            agent_part,
            reins_part,
            report_hash,
            settled_at: now,
        });
        Ok(())
    }
}

/// `amount` split at `bps` for Reins: Reins gets the floor, the agent the
/// rest, so the parts always add up to the whole.
pub fn split(amount: u64, bps: u16) -> Result<(u64, u64)> {
    let reins = (amount as u128 * bps as u128 / BPS as u128) as u64;
    Ok((amount - reins, reins))
}

/// (fee, new high-water mark) for a reported PnL. No fee until a mark is set,
/// and none unless the PnL is above it.
pub fn performance_fee(hwm_set: bool, hwm: i64, pnl: i64, fee_bps: u16) -> Result<(u64, i64)> {
    if !hwm_set {
        return Ok((0, pnl));
    }
    if pnl <= hwm {
        return Ok((0, hwm));
    }
    let gain = (pnl as i128 - hwm as i128) as u128;
    let fee = gain * fee_bps as u128 / BPS as u128;
    Ok((u64::try_from(fee).map_err(|_| FollowError::Overflow)?, pnl))
}

fn pay<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = Transfer { from: from.to_account_info(), to: to.to_account_info(), authority: authority.clone() };
    match seeds {
        Some(s) => {
            let signer: &[&[&[u8]]] = &[s];
            token::transfer(CpiContext::new_with_signer(token_program.to_account_info(), accounts, signer), amount)
        }
        None => token::transfer(CpiContext::new(token_program.to_account_info(), accounts), amount),
    }
}

/// How the copier sizes a follower's orders and what it must never exceed.
/// Amounts are in the exchange quote's smallest unit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct Settings {
    /// SIZE_FIXED: `size_value` per trade. SIZE_PERCENT: `size_value` bps of account value.
    pub size_mode: u8,
    pub size_value: u64,
    /// Largest single copied trade.
    pub max_trade: u64,
    /// Most copied positions open at once.
    pub max_open: u8,
    /// Copying pauses for the day once the day's loss reaches this.
    pub daily_loss_cap: u64,
}

impl Settings {
    pub fn check(&self) -> Result<()> {
        let size_ok = match self.size_mode {
            SIZE_FIXED => self.size_value > 0,
            SIZE_PERCENT => self.size_value > 0 && self.size_value <= BPS,
            _ => false,
        };
        require!(size_ok, FollowError::BadSettings);
        require!(self.max_trade > 0 && self.daily_loss_cap > 0, FollowError::BadSettings);
        require!((1..=MAX_OPEN_COPIED).contains(&self.max_open), FollowError::BadSettings);
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(token::mint = mint)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED, admin.key().as_ref()], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPlan<'info> {
    /// The agent's key: the owner of its Arena book.
    pub agent: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(token::mint = config.mint)]
    pub payout: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Plan::INIT_SPACE,
        seeds = [PLAN_SEED, config.key().as_ref(), agent.key().as_ref()],
        bump,
    )]
    pub plan: Account<'info, Plan>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(mut)]
    pub follower: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(has_one = config, has_one = payout)]
    pub plan: Account<'info, Plan>,
    #[account(
        init_if_needed,
        payer = follower,
        space = 8 + Follow::INIT_SPACE,
        seeds = [FOLLOW_SEED, plan.key().as_ref(), follower.key().as_ref()],
        bump,
    )]
    pub follow: Account<'info, Follow>,
    #[account(mut, token::mint = config.mint, token::authority = follower)]
    pub follower_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payout: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury)]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FollowerOnly<'info> {
    pub follower: Signer<'info>,
    #[account(mut, has_one = follower, seeds = [FOLLOW_SEED, follow.plan.as_ref(), follower.key().as_ref()], bump = follow.bump)]
    pub follow: Account<'info, Follow>,
}

#[derive(Accounts)]
pub struct SettlePerformance<'info> {
    /// The config's admin: the settler that measured the PnL.
    pub admin: Signer<'info>,
    #[account(has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(has_one = config, has_one = payout)]
    pub plan: Account<'info, Plan>,
    #[account(
        mut,
        has_one = plan,
        seeds = [FOLLOW_SEED, plan.key().as_ref(), follow.follower.as_ref()],
        bump = follow.bump,
    )]
    pub follow: Account<'info, Follow>,
    #[account(mut, token::mint = config.mint, constraint = follower_token.owner == follow.follower @ FollowError::NotFollowersAccount)]
    pub follower_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payout: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury)]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------- state

/// At ["config", admin].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub admin: Pubkey,
    /// The payment mint (USDC).
    pub mint: Pubkey,
    /// Reins' token account for its share.
    pub treasury: Pubkey,
    /// Reins' share of subscriptions.
    pub reins_bps: u16,
    /// Reins' share of performance fees.
    pub perf_reins_bps: u16,
}

/// At ["plan", config, agent].
#[account]
#[derive(InitSpace)]
pub struct Plan {
    pub version: u8,
    pub bump: u8,
    pub config: Pubkey,
    pub agent: Pubkey,
    /// The agent owner's token account for its share.
    pub payout: Pubkey,
    /// Per month, in the mint's smallest unit.
    pub price: u64,
    /// Share of a follower's copied profit above the high-water mark.
    pub perf_fee_bps: u16,
    /// Taking new subscriptions.
    pub open: bool,
    pub created_at: i64,
}

/// At ["follow", plan, follower].
#[account]
#[derive(InitSpace)]
pub struct Follow {
    pub version: u8,
    pub bump: u8,
    pub plan: Pubkey,
    pub follower: Pubkey,
    pub paid_until: i64,
    /// False once the follower stops; the copier skips it.
    pub active: bool,
    pub settings: Settings,
    pub hwm_set: bool,
    /// The high-water mark: the highest PnL a fee has been settled at.
    pub hwm: i64,
    pub total_paid: u64,
    pub perf_fees_paid: u64,
    pub settlements: u32,
    pub last_settled_at: i64,
    pub created_at: i64,
}

// ---------------------------------------------------------------- events

#[event]
pub struct ConfigSet {
    pub config: Pubkey,
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub reins_bps: u16,
    pub perf_reins_bps: u16,
}

#[event]
pub struct PlanSet {
    pub plan: Pubkey,
    pub agent: Pubkey,
    pub payout: Pubkey,
    pub price: u64,
    pub perf_fee_bps: u16,
    pub open: bool,
}

#[event]
pub struct Subscribed {
    pub follow: Pubkey,
    pub plan: Pubkey,
    pub follower: Pubkey,
    pub months: u8,
    pub total: u64,
    pub agent_part: u64,
    pub reins_part: u64,
    pub paid_until: i64,
    pub settings: Settings,
}

#[event]
pub struct SettingsChanged {
    pub follow: Pubkey,
    pub settings: Settings,
}

#[event]
pub struct Stopped {
    pub follow: Pubkey,
    pub follower: Pubkey,
}

#[event]
pub struct PerformanceSettled {
    pub follow: Pubkey,
    pub follower: Pubkey,
    pub pnl: i64,
    pub hwm_before: i64,
    pub hwm_after: i64,
    pub fee: u64,
    pub agent_part: u64,
    pub reins_part: u64,
    pub report_hash: [u8; 32],
    pub settled_at: i64,
}

#[error_code]
pub enum FollowError {
    #[msg("A rate is at most 5000 bps")]
    BadRate,
    #[msg("Subscribe for 1 to 12 months")]
    BadMonths,
    #[msg("This plan isn't taking subscriptions")]
    PlanClosed,
    #[msg("Size and limits must be set, and at most 10 copied positions open")]
    BadSettings,
    #[msg("That token account isn't the follower's")]
    NotFollowersAccount,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_always_add_up() {
        for (amount, bps) in [(0u64, 2000u16), (1, 2000), (999_999, 2000), (10_000_001, 1234), (u64::MAX, 5000), (7, 0)] {
            let (a, r) = split(amount, bps).unwrap();
            assert_eq!(a + r, amount);
            assert_eq!(r as u128, amount as u128 * bps as u128 / 10_000);
        }
    }

    #[test]
    fn the_fee_is_only_above_the_high_water_mark() {
        assert_eq!(performance_fee(false, 0, 5_000, 2000).unwrap(), (0, 5_000)); // first: sets the mark
        assert_eq!(performance_fee(true, 5_000, 4_000, 2000).unwrap(), (0, 5_000)); // below: no fee, mark holds
        assert_eq!(performance_fee(true, 5_000, 5_000, 2000).unwrap(), (0, 5_000));
        assert_eq!(performance_fee(true, 5_000, 6_000, 2000).unwrap(), (200, 6_000)); // 20% of the 1000 gain
        assert_eq!(performance_fee(true, -3_000, -1_000, 2000).unwrap(), (400, -1_000)); // gains from a loss count
        assert_eq!(performance_fee(true, i64::MIN, i64::MAX, 5000).unwrap().0, (u64::MAX / 2)); // no overflow
    }
}
