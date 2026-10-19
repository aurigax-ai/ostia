# Secrets and sandboxes

```sh
echo -n "$TOKEN" | ostia vault set API_KEY [--global]   # the value comes from stdin only
ostia vault get API_KEY [--global] | vault list [--global] | vault rm API_KEY [--global]
ostia sandbox request-domain api.example.com   # asks the human; prints "allowed: …" or exits 1
ostia sandbox expose 5173                       # forwards 127.0.0.1:5173 on the human's computer
ostia secret list                               # names the sandbox may ask for, never values
ostia secret get DB_PASSWORD --reason "run the migrations"
```

The vault is per project folder, or machine-wide with `--global` (writing there needs
`all-workspaces`); it fails with `encryption-unavailable` when the OS keychain is missing. A
workspace is sandboxed when `$HTTPS_PROXY` is an `http://srt…` address: it reads and writes only
its folder and a private `$TMPDIR`, reaches only allowed hosts, and `vault get` is refused there.
A blocked download answers 403 with the reason. On Linux the rest of the home folder is an empty
in-memory copy that is gone when the shell exits.
