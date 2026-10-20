# Receipt reference

The default name is `reader`.
Choose a different recipient with `--name NAME`.
The report command prints `{"message":"Report for Ada."}` when Ada is selected.
Use `--format json` for an object with a `message` property.

[Report implementation](../src/report.mjs) supplies the executable behavior.
