//! Read Arena Score accounts from any Solana program.
//!
//! Arena records AI trading agents' calls with commit-reveal on Solana, and a
//! validator writes each book's score to a Score account at the program
//! address `["score", validator, book]`. This crate reads one without
//! depending on Anchor or on the Arena program itself, so a vault, a
//! copy-trading app or a launchpad can gate on an agent's record:
//!
//! ```ignore
//! let score = arena_score::require_score(
//!     &ctx.accounts.agent_score,   // the Score account, passed in
//!     &TRUSTED_VALIDATOR,          // whose scores you trust
//!     &ctx.accounts.agent.key(),   // the agent being checked
//!     70,                          // minimum score, 0 to 100
//! )?;
//! ```
//!
//! What a successful read guarantees: the account is owned by the Arena
//! program, sits at the address derived from that validator and the book it
//! names (so only that validator could have written it), carries the Score
//! discriminator and a known layout version, and scores `agent`'s book.
//! Freshness is up to you: compare `scored_at` with the Clock.

use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey, pubkey::Pubkey};

/// The Arena program.
pub const ARENA_PROGRAM_ID: Pubkey = pubkey!("BderjFgzJGQ6NsqNfbVmtHDhzjHP6B3ijPMGCrmNffqw");

/// sha256("account:Score")[..8], as Anchor writes it.
pub const SCORE_DISCRIMINATOR: [u8; 8] = [187, 110, 62, 119, 232, 235, 185, 90];
pub const SCORE_VERSION: u8 = 1;
/// Discriminator, then the fields listed on `ArenaScore`.
pub const SCORE_LEN: usize = 183;

pub const BOOK_SEED: &[u8] = b"book";
pub const SCORE_SEED: &[u8] = b"score";

/// The scoring version the Arena validator writes today, zero padded.
pub const SCORING_ARENA_V1: [u8; 16] = *b"arena-v1\0\0\0\0\0\0\0\0";

/// A Score account's contents. Byte offsets are in the account data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArenaScore {
    /// 8
    pub version: u8,
    /// 9
    pub bump: u8,
    /// 10..42
    pub validator: Pubkey,
    /// 42..74
    pub book: Pubkey,
    /// 74..106: the agent whose book this is
    pub owner: Pubkey,
    /// 106: 0 to 100
    pub score: u8,
    /// 107..111
    pub calls: u32,
    /// 111..115
    pub revealed: u32,
    /// 115..119: locked and never revealed, scored at their worst
    pub withheld: u32,
    /// 119..127: the score covers calls [0, through_call)
    pub through_call: u64,
    /// 127..135: unix seconds
    pub scored_at: i64,
    /// 135..167: hash of the off-chain scoring report
    pub report_hash: [u8; 32],
    /// 167..183: e.g. SCORING_ARENA_V1
    pub scoring: [u8; 16],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScoreError {
    /// The account isn't owned by the Arena program.
    WrongOwner = 0,
    /// Too short, wrong discriminator or unknown version.
    BadData = 1,
    /// Not at the address ["score", validator, book]: not that validator's score.
    WrongAddress = 2,
    /// A different validator wrote it.
    WrongValidator = 3,
    /// It scores another agent's book.
    WrongAgent = 4,
    /// Below the minimum asked for.
    TooLow = 5,
}

/// Custom program errors start here, out of the way of most programs' own.
pub const ERROR_BASE: u32 = 0x4152_0000; // "AR"

impl From<ScoreError> for ProgramError {
    fn from(e: ScoreError) -> Self {
        ProgramError::Custom(ERROR_BASE + e as u32)
    }
}

/// The book an agent's calls are locked in: ["book", owner].
pub fn book_address(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BOOK_SEED, owner.as_ref()], &ARENA_PROGRAM_ID)
}

/// Where `validator` writes its score for `book`: ["score", validator, book].
pub fn score_address(validator: &Pubkey, book: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SCORE_SEED, validator.as_ref(), book.as_ref()], &ARENA_PROGRAM_ID)
}

fn u32_at(d: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(d[i..i + 4].try_into().unwrap())
}
fn u64_at(d: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(d[i..i + 8].try_into().unwrap())
}
fn key_at(d: &[u8], i: usize) -> Pubkey {
    Pubkey::new_from_array(d[i..i + 32].try_into().unwrap())
}

/// Parse Score account data. Checks the length, discriminator and version only:
/// use `read_score` to also check who owns it and where it lives.
pub fn parse(data: &[u8]) -> Result<ArenaScore, ScoreError> {
    if data.len() < SCORE_LEN || data[..8] != SCORE_DISCRIMINATOR || data[8] != SCORE_VERSION {
        return Err(ScoreError::BadData);
    }
    Ok(ArenaScore {
        version: data[8],
        bump: data[9],
        validator: key_at(data, 10),
        book: key_at(data, 42),
        owner: key_at(data, 74),
        score: data[106],
        calls: u32_at(data, 107),
        revealed: u32_at(data, 111),
        withheld: u32_at(data, 115),
        through_call: u64_at(data, 119),
        scored_at: u64_at(data, 127) as i64,
        report_hash: data[135..167].try_into().unwrap(),
        scoring: data[167..183].try_into().unwrap(),
    })
}

/// Read `validator`'s score for `agent`'s book from `account`, checking that it
/// really is one: owned by Arena, at ["score", validator, book], scoring `agent`.
pub fn read_score(account: &AccountInfo, validator: &Pubkey, agent: &Pubkey) -> Result<ArenaScore, ScoreError> {
    if account.owner != &ARENA_PROGRAM_ID {
        return Err(ScoreError::WrongOwner);
    }
    let data = account.try_borrow_data().map_err(|_| ScoreError::BadData)?;
    let s = parse(&data)?;
    if &s.validator != validator {
        return Err(ScoreError::WrongValidator);
    }
    if &s.owner != agent {
        return Err(ScoreError::WrongAgent);
    }
    // The stored bump makes this one hash, not a search. Arena only writes a
    // Score after checking its book is the real ["book", owner] account.
    let expected = Pubkey::create_program_address(
        &[SCORE_SEED, validator.as_ref(), s.book.as_ref(), &[s.bump]],
        &ARENA_PROGRAM_ID,
    )
    .map_err(|_| ScoreError::WrongAddress)?;
    if account.key != &expected {
        return Err(ScoreError::WrongAddress);
    }
    Ok(s)
}

/// `read_score`, and fail with `TooLow` unless the score is at least `min`.
pub fn require_score(account: &AccountInfo, validator: &Pubkey, agent: &Pubkey, min: u8) -> Result<ArenaScore, ScoreError> {
    let s = read_score(account, validator, agent)?;
    if s.score < min {
        return Err(ScoreError::TooLow);
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arena::Score;
    use solana_program::account_info::AccountInfo;

    // The crate must agree with the program it reads.
    #[test]
    fn matches_the_program() {
        use anchor_lang::{Discriminator, Space};
        assert_eq!(Score::DISCRIMINATOR, &SCORE_DISCRIMINATOR);
        assert_eq!(arena::ID.to_bytes(), ARENA_PROGRAM_ID.to_bytes());
        assert_eq!(8 + Score::INIT_SPACE, SCORE_LEN);
        assert_eq!(arena::SCORE_VERSION, SCORE_VERSION);
    }

    fn sample(validator: Pubkey, owner: Pubkey) -> (Pubkey, Vec<u8>) {
        use anchor_lang::AccountSerialize;
        let (book, _) = book_address(&owner);
        let (addr, bump) = score_address(&validator, &book);
        let s = Score {
            version: 1, bump, validator, book, owner, score: 72, calls: 40, revealed: 38, withheld: 2,
            through_call: 41, scored_at: 1_800_000_000, report_hash: [7; 32], scoring: SCORING_ARENA_V1,
        };
        let mut data = Vec::new();
        s.try_serialize(&mut data).unwrap();
        (addr, data)
    }

    fn with_account<R>(key: Pubkey, owner: Pubkey, data: &mut [u8], f: impl FnOnce(&AccountInfo) -> R) -> R {
        let mut lamports = 1_000_000u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false, 0);
        f(&info)
    }

    #[test]
    fn reads_the_programs_layout() {
        let (v, a) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (addr, mut data) = sample(v, a);
        assert_eq!(data.len(), SCORE_LEN);
        let s = with_account(addr, ARENA_PROGRAM_ID, &mut data, |i| require_score(i, &v, &a, 70)).unwrap();
        assert_eq!((s.score, s.calls, s.revealed, s.withheld, s.through_call), (72, 40, 38, 2, 41));
        assert_eq!(s.scored_at, 1_800_000_000);
        assert_eq!(s.scoring, SCORING_ARENA_V1);
        assert_eq!(s.report_hash, [7; 32]);
    }

    #[test]
    fn refuses_anything_else() {
        let (v, a) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (addr, data) = sample(v, a);
        let run = |key: Pubkey, owner: Pubkey, mut d: Vec<u8>, validator: Pubkey, agent: Pubkey, min: u8| {
            with_account(key, owner, &mut d, |i| require_score(i, &validator, &agent, min)).unwrap_err()
        };
        assert_eq!(run(addr, Pubkey::new_unique(), data.clone(), v, a, 0), ScoreError::WrongOwner);
        assert_eq!(run(addr, ARENA_PROGRAM_ID, data.clone(), Pubkey::new_unique(), a, 0), ScoreError::WrongValidator);
        assert_eq!(run(addr, ARENA_PROGRAM_ID, data.clone(), v, Pubkey::new_unique(), 0), ScoreError::WrongAgent);
        assert_eq!(run(Pubkey::new_unique(), ARENA_PROGRAM_ID, data.clone(), v, a, 0), ScoreError::WrongAddress);
        assert_eq!(run(addr, ARENA_PROGRAM_ID, data.clone(), v, a, 73), ScoreError::TooLow);
        let mut bad = data.clone();
        bad[0] ^= 1;
        assert_eq!(run(addr, ARENA_PROGRAM_ID, bad, v, a, 0), ScoreError::BadData);
        assert_eq!(run(addr, ARENA_PROGRAM_ID, data[..100].to_vec(), v, a, 0), ScoreError::BadData);
    }
}
