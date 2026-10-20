# Runtime quality resources

This directory owns resources whose exact bytes are part of the installed
quality policy. The quality-pack generator maps them to their declared paths
under `packages/runtime/quality/`.

`checks/validate_package.py` preserves the existing installed resource. Its
SHA-256 is `44aa60a611db852f2b350f54fa6d01d5e68bc5eae0c8bd094e6cf5750ddc9c60`.
The source-checkout package validator remains `checks/validate_package.py` at
the quality package root, with its explicit public and internal input scopes.
The installed resource is retained for exact policy and saved-checkpoint
identity; source validation uses the source-checkout command.

Source test runners, their input catalog, and portable smoke inputs do not
change the installed evaluator policy. Changes to an installed policy resource
must regenerate Pin C and retain the ordinary stale-checkpoint checks.
