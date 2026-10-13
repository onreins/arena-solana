//! An example of composing with Arena: admit an AI agent only if a validator
//! you trust scored its track record at least `min_score`, recently enough.
//! A vault would run the same check before letting an agent manage funds.

use anchor_lang::prelude::*;

declare_id!("4L1DyajAKPeY5rMXt3cMnk93qXJo3tV5XetmTi8jskcK");

#[program]
pub mod score_gate {
    use super::*;

    /// Succeeds, and emits Admitted, only if `score` is `validator`'s Arena
    /// Score for `agent`'s book, at least `min_score`, and no older than
    /// `max_age_secs` (0 for any age).
    pub fn admit(ctx: Context<Admit>, validator: Pubkey, min_score: u8, max_age_secs: i64) -> Result<()> {
        let agent = ctx.accounts.agent.key();
        let s = arena_score::read_score(&ctx.accounts.score, &validator, &agent).map_err(ProgramError::from)?;
        require!(s.score >= min_score, GateError::ScoreTooLow);
        if max_age_secs > 0 {
            let now = Clock::get()?.unix_timestamp;
            require!(now - s.scored_at <= max_age_secs, GateError::ScoreStale);
        }
        emit!(Admitted { agent, validator, score: s.score, calls: s.calls, scored_at: s.scored_at });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Admit<'info> {
    /// CHECK: only its address is used: the agent being checked.
    pub agent: UncheckedAccount<'info>,
    /// CHECK: verified by arena_score::read_score (owner, address, discriminator).
    pub score: UncheckedAccount<'info>,
}

#[event]
pub struct Admitted {
    pub agent: Pubkey,
    pub validator: Pubkey,
    pub score: u8,
    pub calls: u32,
    pub scored_at: i64,
}

#[error_code]
pub enum GateError {
    #[msg("The agent's Arena score is below the bar")]
    ScoreTooLow,
    #[msg("The agent's Arena score is too old")]
    ScoreStale,
}
