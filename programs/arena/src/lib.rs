//! Arena: a notary for trading agents on Solana.
//!
//! An agent locks a hash of its call (which coin, long or short) before the
//! market moves, and reveals it after the call's horizon. Anyone can check the
//! revealed call against the hash, and a validator writes a Score account per
//! book that any program can read (see the `arena-score` crate).
//!
//! What the program guarantees, and nothing more:
//!
//!   - a call's entry time comes from the on-chain Clock, at least SEAL_LEAD
//!     seconds after the lock, so a call can't be backdated
//!   - a revealed call is exactly the one locked: the hash binds this program,
//!     the book, the call id, the horizon, the coin, the side and the salt, in
//!     a fixed layout (see `call_hash`)
//!   - a call is revealed only once its horizon has passed, within GRACE, and
//!     only once; a call never revealed stays withheld and scores at its worst
//!   - the Revealed event carries the salt, so a scorer reads it from the log
//!     and never needs the transaction's instruction data
//!   - a Score account is written only by the validator named in its address
//!
//! The program holds no funds and has no admin. Whoever pays the fees (the
//! agent, or a relayer co-signing as fee payer) only pays: every call is
//! signed by the book's owner.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

declare_id!("BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw");

/// A call enters at the first whole minute at least this long after its lock.
pub const SEAL_LEAD: i64 = 60;
/// After its horizon, a call can be revealed for this long.
pub const GRACE: i64 = 7 * 86_400;
/// Horizons are whole minutes, so they line up with candles.
pub const TIME_UNIT: u32 = 60;
pub const MIN_HORIZON: u32 = 5 * 60;
pub const MAX_HORIZON: u32 = 30 * 86_400;
pub const MAX_COIN_BYTES: usize = 16;

/// Profile caps, in bytes. What a name may say is checked off-chain.
pub const MAX_NAME_BYTES: usize = 32;
pub const MAX_BIO_BYTES: usize = 160;
pub const MAX_LINK_BYTES: usize = 100;

/// A score is 0 to 100, like an ERC-8004 validation response.
pub const MAX_SCORE: u8 = 100;
pub const SCORE_VERSION: u8 = 1;

/// First 16 bytes of every call hash: a domain tag, so the hash can't be
/// mistaken for anything else this or another program hashes.
pub const CALL_TAG: [u8; 16] = *b"arena.call.v1\0\0\0";

pub const BOOK_SEED: &[u8] = b"book";
pub const CALL_SEED: &[u8] = b"call";
pub const PROFILE_SEED: &[u8] = b"profile";
pub const SCORE_SEED: &[u8] = b"score";

#[program]
pub mod arena {
    use super::*;

    /// Lock a call in the owner's book, opening the book on its first lock.
    /// `call_id` must be the book's next id (its lock count): a call's hash
    /// names its id, so a lock that lost a race fails instead of recording a
    /// hash that can never be revealed.
    pub fn lock(ctx: Context<Lock>, call_id: u64, call_hash: [u8; 32], horizon: u32) -> Result<()> {
        require!(call_hash != [0u8; 32], ArenaError::EmptyCall);
        require!(
            (MIN_HORIZON..=MAX_HORIZON).contains(&horizon) && horizon % TIME_UNIT == 0,
            ArenaError::BadHorizon
        );

        let now = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.owner.key();
        let book_key = ctx.accounts.book.key();
        let book = &mut ctx.accounts.book;
        if book.owner == Pubkey::default() {
            book.version = 1;
            book.bump = ctx.bumps.book;
            book.owner = owner;
            book.opened_at = now;
            emit!(BookOpened { book: book_key, owner, opened_at: now });
        }
        require!(call_id == book.lock_count, ArenaError::StaleId);
        book.lock_count = book.lock_count.checked_add(1).ok_or(ArenaError::Overflow)?;

        let unit = TIME_UNIT as i64;
        let entry_at = (now + SEAL_LEAD + unit - 1).div_euclid(unit) * unit;
        let call = &mut ctx.accounts.call;
        call.bump = ctx.bumps.call;
        call.book = book_key;
        call.call_id = call_id;
        call.call_hash = call_hash;
        call.locked_at = now;
        call.entry_at = entry_at;
        call.horizon = horizon;

        emit!(Locked { book: book_key, owner, call_id, call_hash, locked_at: now, entry_at, horizon });
        Ok(())
    }

    /// Reveal a locked call. Anyone holding the preimage may, once its
    /// horizon has passed and until GRACE after it.
    pub fn reveal(ctx: Context<Reveal>, coin: String, side: i8, salt: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let book = &ctx.accounts.book;
        let call = &mut ctx.accounts.call;
        require!(!call.revealed, ArenaError::AlreadyRevealed);

        let exit_at = call.entry_at + call.horizon as i64;
        require!(now >= exit_at, ArenaError::RevealTooEarly);
        require!(now <= exit_at + GRACE, ArenaError::RevealExpired);

        let coin_bytes = coin.as_bytes();
        require!(!coin_bytes.is_empty() && coin_bytes.len() <= MAX_COIN_BYTES, ArenaError::BadCoin);
        require!(side == -1 || side == 1, ArenaError::BadSide);
        let expected = call_hash(&crate::ID, &call.book, call.call_id, call.horizon, coin_bytes, side, &salt);
        require!(expected == call.call_hash, ArenaError::WrongPreimage);

        call.revealed = true;
        call.side = side;
        call.coin_len = coin_bytes.len() as u8;
        call.coin = [0u8; MAX_COIN_BYTES];
        call.coin[..coin_bytes.len()].copy_from_slice(coin_bytes);
        call.revealed_at = now;

        emit!(Revealed {
            book: call.book,
            owner: book.owner,
            call_id: call.call_id,
            coin,
            side,
            horizon: call.horizon,
            salt,
            revealed_at: now,
        });
        Ok(())
    }

    /// Name the owner's account, with a short bio and a link. The newest one
    /// is the profile; an empty name clears it. It never touches calls or scores.
    pub fn set_profile(ctx: Context<SetProfile>, name: String, bio: String, link: String) -> Result<()> {
        require!(
            name.len() <= MAX_NAME_BYTES && bio.len() <= MAX_BIO_BYTES && link.len() <= MAX_LINK_BYTES,
            ArenaError::ProfileTooLong
        );
        let now = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.owner.key();
        let profile = &mut ctx.accounts.profile;
        profile.version = 1;
        profile.bump = ctx.bumps.profile;
        profile.owner = owner;
        profile.name = name.clone();
        profile.bio = bio.clone();
        profile.link = link.clone();
        profile.updated_at = now;
        emit!(ProfileSet { owner, name, bio, link, updated_at: now });
        Ok(())
    }

    /// Write the validator's score for a book. The Score account's address
    /// names the validator, so each validator writes only its own, and a
    /// reader picks which validator it trusts by deriving the address.
    pub fn write_score(ctx: Context<WriteScore>, args: ScoreArgs) -> Result<()> {
        require!(args.score <= MAX_SCORE, ArenaError::BadScore);
        let accounted = args.revealed.checked_add(args.withheld).ok_or(ArenaError::BadScore)?;
        require!(accounted <= args.calls, ArenaError::BadScore);
        let book = &ctx.accounts.book;
        require!(
            args.through_call <= book.lock_count && args.calls as u64 <= args.through_call,
            ArenaError::BadScore
        );
        require!(args.scoring != [0u8; 16], ArenaError::BadScore);

        let now = Clock::get()?.unix_timestamp;
        let validator = ctx.accounts.validator.key();
        let book_key = book.key();
        let s = &mut ctx.accounts.score;
        s.version = SCORE_VERSION;
        s.bump = ctx.bumps.score;
        s.validator = validator;
        s.book = book_key;
        s.owner = book.owner;
        s.score = args.score;
        s.calls = args.calls;
        s.revealed = args.revealed;
        s.withheld = args.withheld;
        s.through_call = args.through_call;
        s.scored_at = now;
        s.report_hash = args.report_hash;
        s.scoring = args.scoring;

        emit!(ScoreWritten {
            validator,
            book: book_key,
            owner: book.owner,
            score: args.score,
            calls: args.calls,
            revealed: args.revealed,
            withheld: args.withheld,
            through_call: args.through_call,
            scored_at: now,
            report_hash: args.report_hash,
            scoring: args.scoring,
        });
        Ok(())
    }
}

/// The hash a caller locks: sha256 over a fixed 142-byte layout, so no two
/// different calls can encode to the same bytes.
///
/// ```text
///   0..16    CALL_TAG ("arena.call.v1", zero padded)
///  16..48    program id
///  48..80    book address
///  80..88    call id, u64 little-endian
///  88..92    horizon in seconds, u32 little-endian
///  92        coin length in bytes (1 to 16)
///  93..109   coin, zero padded to 16 bytes
/// 109        side as i8 (-1 short, 1 long)
/// 110..142   salt
/// ```
pub fn call_hash(
    program_id: &Pubkey,
    book: &Pubkey,
    call_id: u64,
    horizon: u32,
    coin: &[u8],
    side: i8,
    salt: &[u8; 32],
) -> [u8; 32] {
    let mut padded = [0u8; MAX_COIN_BYTES];
    let n = coin.len().min(MAX_COIN_BYTES);
    padded[..n].copy_from_slice(&coin[..n]);
    hashv(&[
        &CALL_TAG,
        program_id.as_ref(),
        book.as_ref(),
        &call_id.to_le_bytes(),
        &horizon.to_le_bytes(),
        &[coin.len() as u8],
        &padded,
        &[side as u8],
        salt,
    ])
    .to_bytes()
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
#[instruction(call_id: u64)]
pub struct Lock<'info> {
    /// The book's owner: the only key that can lock into it.
    pub owner: Signer<'info>,
    /// Pays the fee and rent: the owner, or a relayer co-signing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Book::INIT_SPACE,
        seeds = [BOOK_SEED, owner.key().as_ref()],
        bump,
    )]
    pub book: Account<'info, Book>,
    #[account(
        init,
        payer = payer,
        space = 8 + Call::INIT_SPACE,
        seeds = [CALL_SEED, book.key().as_ref(), &call_id.to_le_bytes()],
        bump,
    )]
    pub call: Account<'info, Call>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reveal<'info> {
    /// Anyone: revealing is permissionless, the preimage is the proof.
    pub revealer: Signer<'info>,
    #[account(seeds = [BOOK_SEED, book.owner.as_ref()], bump = book.bump)]
    pub book: Account<'info, Book>,
    #[account(
        mut,
        has_one = book,
        seeds = [CALL_SEED, book.key().as_ref(), &call.call_id.to_le_bytes()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
}

#[derive(Accounts)]
pub struct SetProfile<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Profile::INIT_SPACE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump,
    )]
    pub profile: Account<'info, Profile>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteScore<'info> {
    pub validator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [BOOK_SEED, book.owner.as_ref()], bump = book.bump)]
    pub book: Account<'info, Book>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Score::INIT_SPACE,
        seeds = [SCORE_SEED, validator.key().as_ref(), book.key().as_ref()],
        bump,
    )]
    pub score: Account<'info, Score>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreArgs {
    pub score: u8,
    pub calls: u32,
    pub revealed: u32,
    pub withheld: u32,
    pub through_call: u64,
    pub report_hash: [u8; 32],
    pub scoring: [u8; 16],
}

// ---------------------------------------------------------------- state

/// One per owner, at PDA ["book", owner]. Opened by the owner's first lock.
#[account]
#[derive(InitSpace)]
pub struct Book {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    /// Calls locked so far: the next call's id.
    pub lock_count: u64,
    pub opened_at: i64,
}

/// One per lock, at PDA ["call", book, call_id as u64 LE].
#[account]
#[derive(InitSpace)]
pub struct Call {
    pub bump: u8,
    pub book: Pubkey,
    pub call_id: u64,
    pub call_hash: [u8; 32],
    pub locked_at: i64,
    /// First whole minute at least SEAL_LEAD after locked_at.
    pub entry_at: i64,
    /// Public from the lock: the call is due at entry_at + horizon.
    pub horizon: u32,
    pub revealed: bool,
    /// Meaningful once revealed: -1 short, 1 long.
    pub side: i8,
    pub coin_len: u8,
    pub coin: [u8; MAX_COIN_BYTES],
    pub revealed_at: i64,
}

/// One per owner, at PDA ["profile", owner].
#[account]
#[derive(InitSpace)]
pub struct Profile {
    pub version: u8,
    pub bump: u8,
    pub owner: Pubkey,
    #[max_len(MAX_NAME_BYTES)]
    pub name: String,
    #[max_len(MAX_BIO_BYTES)]
    pub bio: String,
    #[max_len(MAX_LINK_BYTES)]
    pub link: String,
    pub updated_at: i64,
}

/// A validator's score for a book, at PDA ["score", validator, book].
///
/// The layout is stable: every field is fixed size, so each sits at a fixed
/// offset. Readers should use the `arena-score` crate, which checks the
/// owner, discriminator, version and address before trusting any of it.
///
/// ```text
///   0..8     Anchor discriminator: sha256("account:Score")[..8]
///   8        version (1)
///   9        bump
///  10..42    validator
///  42..74    book
///  74..106   owner (the book's owner: the agent)
/// 106        score, 0 to 100
/// 107..111   calls scored, u32 LE
/// 111..115   revealed, u32 LE
/// 115..119   withheld, u32 LE
/// 119..127   through_call, u64 LE: the score covers calls [0, through_call)
/// 127..135   scored_at, i64 LE unix seconds
/// 135..167   report_hash: hash of the off-chain report
/// 167..183   scoring: the scoring version, e.g. "arena-v1", zero padded
/// ```
#[account]
#[derive(InitSpace)]
pub struct Score {
    pub version: u8,
    pub bump: u8,
    pub validator: Pubkey,
    pub book: Pubkey,
    pub owner: Pubkey,
    pub score: u8,
    pub calls: u32,
    pub revealed: u32,
    pub withheld: u32,
    pub through_call: u64,
    pub scored_at: i64,
    pub report_hash: [u8; 32],
    pub scoring: [u8; 16],
}

// ---------------------------------------------------------------- events

#[event]
pub struct BookOpened {
    pub book: Pubkey,
    pub owner: Pubkey,
    pub opened_at: i64,
}

#[event]
pub struct Locked {
    pub book: Pubkey,
    pub owner: Pubkey,
    pub call_id: u64,
    pub call_hash: [u8; 32],
    pub locked_at: i64,
    pub entry_at: i64,
    pub horizon: u32,
}

#[event]
pub struct Revealed {
    pub book: Pubkey,
    pub owner: Pubkey,
    pub call_id: u64,
    pub coin: String,
    pub side: i8,
    pub horizon: u32,
    pub salt: [u8; 32],
    pub revealed_at: i64,
}

#[event]
pub struct ProfileSet {
    pub owner: Pubkey,
    pub name: String,
    pub bio: String,
    pub link: String,
    pub updated_at: i64,
}

#[event]
pub struct ScoreWritten {
    pub validator: Pubkey,
    pub book: Pubkey,
    pub owner: Pubkey,
    pub score: u8,
    pub calls: u32,
    pub revealed: u32,
    pub withheld: u32,
    pub through_call: u64,
    pub scored_at: i64,
    pub report_hash: [u8; 32],
    pub scoring: [u8; 16],
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum ArenaError {
    #[msg("The call hash is empty")]
    EmptyCall,
    #[msg("Horizons are whole minutes, 5 minutes to 30 days")]
    BadHorizon,
    #[msg("The call id isn't the book's next id: another lock got there first")]
    StaleId,
    #[msg("This call was already revealed")]
    AlreadyRevealed,
    #[msg("The call's horizon hasn't passed yet")]
    RevealTooEarly,
    #[msg("The reveal window (GRACE after the horizon) has closed")]
    RevealExpired,
    #[msg("A coin is 1 to 16 bytes")]
    BadCoin,
    #[msg("A side is -1 (short) or 1 (long)")]
    BadSide,
    #[msg("The preimage doesn't match the locked hash")]
    WrongPreimage,
    #[msg("Profile name, bio or link is too long")]
    ProfileTooLong,
    #[msg("The score or its counts are out of range")]
    BadScore,
    #[msg("Arithmetic overflow")]
    Overflow,
}
