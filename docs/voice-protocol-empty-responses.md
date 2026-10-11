# The voice protocol answers empty where ServerQuery answers with data

Measured against a live TS3 3.13.8 and TS6 6.0.0-beta13.1, both as Server Admin.
This is the single most important thing to know before adding commands.

## What happens

A client connected over the **voice protocol** (UDP 9987 — the one a real
TeamSpeak client uses, and the one this SDK speaks) gets no data for a set of
commands that ServerQuery answers normally. The server replies:

```
error id=0 msg=ok return_code=1
```

Success, with no data row before it. Not an error, not a timeout — an empty
result that looks exactly like "there is nothing to list".

The same command, at the same moment, against the same virtual server, with the
same admin rights, over ServerQuery (TCP 10011):

```
servergrouplist
sgid=1 name=Guest\sServer\sQuery type=2 iconid=0 savedb=0 ...
sgid=2 name=Admin\sServer\sQuery type=2 iconid=5 ...
error id=0 msg=ok
```

## Confirmed empty over the voice protocol

Verified with the bot holding **Server Admin** (`sgid=6`), so permissions are
ruled out:

| Command                 | Voice protocol | ServerQuery |
| ----------------------- | -------------- | ----------- |
| `servergrouplist`       | no rows        | rows        |
| `channelgrouplist`      | no rows        | rows        |
| `permissionlist`        | no rows        | rows        |
| `servergrouppermlist`   | no rows        | rows        |
| `clientgetuidfromclid`  | no rows        | rows        |
| `clientgetids`          | no rows        | rows        |
| `clientgetdbidfromuid`  | no rows        | rows        |
| `clientgetnamefromuid`  | no rows        | rows        |
| `clientgetnamefromdbid` | no rows        | rows        |
| `logview`               | no rows        | —           |

Ruled out as causes:

- **Permissions.** Granted Server Admin to the exact identity and retested. The
  empty responses were unchanged, while unrelated commands moved from
  "insufficient permissions" to working — so the grant took effect and these
  are not permission failures.
- **Parsing.** The raw wire shows an `ok` with no data row at all, so there is
  nothing to parse. Traced with a raw packet dump, not inferred.
- **Version.** Identical on TS3 and TS6.

## What still works over the voice protocol

`channellist`, `clientlist`, `clientinfo`, `channelinfo`, `serverinfo`,
`version`, `whoami` and the rest of the command set all return their data
normally — see `scripts/probe-client-commands.mts`, which reports 118 of 123
commands answered.

## Consequences for this SDK

1. **A function that returns `[]` does not mean "nothing there".** Callers must
   not read an empty result as a fact about the server. This is why the
   affected functions carry an explicit note rather than looking like a normal
   empty list.
2. **The affected set cannot be fixed client-side.** It is the server choosing
   not to answer. The SDK's job is to report it honestly, not to paper over it.
3. **Anything needing the empty-listed data must go through ServerQuery.** For a
   bot that only has the voice protocol, that means redesigning rather than
   retrying: `clientlist` carries the uid, so `clientgetuidfromclid` is not
   needed in practice.
4. **Do not add these to the typed API as if they worked.** Each one is a trap:
   it compiles, it returns, it lies.

## How to re-check

```sh
# voice protocol (what the SDK speaks)
npx tsx scripts/survey-voice-empties.mts

# ServerQuery, for comparison
docker exec -i ts3 nc -w 5 127.0.0.1 10011 <<< 'login serveradmin <pw>
use 1
servergrouplist'
```

The survey script prints one line per command: `OK n`, `EMPTY`, or `ERR`, on
both TS3 and TS6. Re-run it when a new server version appears — the empty set is
a server behaviour and could change.
