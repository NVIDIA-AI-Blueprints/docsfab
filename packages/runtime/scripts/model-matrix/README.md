# Model comparison machinery

This directory contains reusable evaluator machinery. The maintained benchmark
configuration and inputs are retained internally. The public configuration
declares this boundary and refuses before provider work.

An independently owned configuration may supply its own sealed corpus,
provider settings, output directory, and authorized credentials. Limits,
credential release, route identity, and source seals retain their normal checks.
No internal benchmark results or release qualification are implied by the
portable test partition.
