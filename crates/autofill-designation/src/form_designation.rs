use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FormDesignation {
    None,
    Login,
    Registration,
    Newsletter,
    ChangePassword,
    ChangeEmail,
    Payment,
    SshKey,
}
