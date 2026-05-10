# Sandbox Templates

Wrappers for worker lanes that should not have full network, git, or package-manager access.

## Files

- `deny-command.sh` - deny wrapper for risky commands
- `git-wrapper.sh` - allow read-only git commands and block pushes by default

Place wrappers earlier in `PATH` for the restricted worker process.
