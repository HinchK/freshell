//! The issue model for manifest validation — zod-parity types.
//!
//! Issues are zod's flattened `{code, path, message}` triples with byte-exact
//! zod-4.3.6 message text (the legacy `.format()` log nesting is intentionally
//! not reproduced; content parity, shape flattened — see `docs/plans/df1/EXT-01.md` DC-3).

// ──────────────────────────────────────────────────────────────
// Issue model (zod-parity)
// ──────────────────────────────────────────────────────────────

/// One path segment — object key or array index (the zod `PropertyKey` subset
/// reachable from JSON).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    Key(String),
    Index(u32),
}

impl serde::Serialize for PathSeg {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            PathSeg::Key(k) => k.serialize(s),
            PathSeg::Index(i) => i.serialize(s),
        }
    }
}

impl std::fmt::Display for PathSeg {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathSeg::Key(k) => write!(f, "{k}"),
            PathSeg::Index(i) => write!(f, "{i}"),
        }
    }
}

/// zod 4.3.6 issue codes reachable from this schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueCode {
    InvalidType,
    TooSmall,
    TooBig,
    InvalidValue,
    UnrecognizedKeys,
    InvalidUnion,
    Custom,
}

impl IssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueCode::InvalidType => "invalid_type",
            IssueCode::TooSmall => "too_small",
            IssueCode::TooBig => "too_big",
            IssueCode::InvalidValue => "invalid_value",
            IssueCode::UnrecognizedKeys => "unrecognized_keys",
            IssueCode::InvalidUnion => "invalid_union",
            IssueCode::Custom => "custom",
        }
    }

    /// DC-4.2: codes whose presence in a refined schema's subtree suppresses
    /// that refine. Aborting: the base-parse failures (invalid_type,
    /// invalid_value, invalid_union, unrecognized_keys). NON-aborting: the
    /// accumulate-only check codes (too_small, too_big) AND custom (a
    /// refine's own output never gates other refines — pinned by the
    /// `both-refine-levels-fire-deeper-first` oracle row).
    pub(crate) fn is_aborting(self) -> bool {
        !matches!(
            self,
            IssueCode::TooSmall | IssueCode::TooBig | IssueCode::Custom
        )
    }
}

impl serde::Serialize for IssueCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// A flattened zod issue: `(code, path, message)` where `message` byte-
/// matches zod 4.3.6's text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ManifestIssue {
    pub code: IssueCode,
    pub path: Vec<PathSeg>,
    pub message: String,
}

impl std::fmt::Display for ManifestIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}", self.code.as_str())?;
        if !self.path.is_empty() {
            write!(f, " ")?;
            for (i, seg) in self.path.iter().enumerate() {
                if i > 0 {
                    write!(f, ".")?;
                }
                write!(f, "{seg}")?;
            }
        }
        write!(f, "] {}", self.message)
    }
}

/// The two rejection classes, mirroring `extension-manager.ts`'s two scan log
/// lines: `InvalidJson` for 'invalid JSON in manifest' (the file text is not
/// JSON at all — legacy logs the `JSON.parse` error), `Invalid` for
/// 'invalid manifest' (parsed JSON failed the schema — carries the zod-parity
/// issue list legacy passes through `result.error.format()`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    InvalidJson(String),
    Invalid(Vec<ManifestIssue>),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::InvalidJson(e) => write!(f, "invalid JSON in manifest: {e}"),
            ManifestError::Invalid(issues) => {
                write!(f, "invalid manifest ({} issue(s)):", issues.len())?;
                for i in issues {
                    write!(f, " {i};")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ManifestError {}
