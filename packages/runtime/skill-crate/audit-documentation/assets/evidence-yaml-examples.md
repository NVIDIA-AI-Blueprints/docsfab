# Evidence YAML snippets (Path A / B / C)

## Path A (Focused document)

```yaml
Path A (Focused document):
  Found: docs/install.md:1-40
  Evidence: |
    # Install
    ## Prerequisites
    ## Install steps
  Conclusion: Page covers install steps; no diagnose or recover section
```

## Path B (Documentation set)

```yaml
Path B (Documentation set):
  Found: docs/troubleshooting.md:12-18
  Evidence: |
    If installation fails, follow the recovery steps in the install guide.
  Conclusion: Set assigns failed-install recovery coverage to docs/install.md
```

## Path C (Outcomes and audiences)

```yaml
Path C (Outcomes and audiences):
  Found: declared operator outcome
  Evidence: |
    outcome: recover from a failed install
    audience: operator
  Conclusion: Required journey is in the frozen job; page coverage is missing
```
