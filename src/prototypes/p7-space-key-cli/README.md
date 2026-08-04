# Local Space Key Setup CLI — Prototype / Throw Away

Question: is a one-shot local Space Key generator enough to serve as the first
V1 setup entry while the Web Setup Page and browser-local Keyring are deferred?

Run:

```sh
pnpm prototype:setup-cli
```

The CLI uses Node's cryptographically secure random source to generate 32 bytes
and prints the canonical `tdp_` plus 43-character unpadded Base64URL form. It
validates its own output with the Production-decided regular expression,
32-byte decoded length, and exact Base64URL round trip.

It performs no network request and does not save, name, import, select, or
recover Keys. The printed Key exists only in terminal output unless the user
stores it. Bearer remains the preferred carrier; Query remains supported only
on the exact `/mcp` endpoint and receives a URL-exposure warning.

This artifact does not decide Production module placement and must not be
imported by Production code.
