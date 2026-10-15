import { TeamspeakError } from "@honeybbq/teamspeak";

/**
 * The `ssh` transport was asked for and `ssh2` is not installed.
 *
 * `ssh2` is an optional peer dependency — ServerQuery over raw TCP and over
 * WebQuery need nothing but Node — so an application that only uses those has
 * no reason to carry it. This says which package to add rather than failing
 * with a module-not-found from inside the loader.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class MissingDependencyError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "MissingDependencyError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "MissingDependencyError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The package to install. */
  readonly package = "ssh2" as const;

  constructor() {
    super('the ssh transport needs the optional dependency "ssh2", which is not installed');
  }
}

/**
 * The server refused an SSH login: a wrong query login name or password, or an
 * account the server does not accept over SSH.
 *
 * SSH logs in before the query protocol starts, so this is not a `ServerError`
 * with a protocol code; the failure is the SSH client's own, kept as this
 * error's `cause`.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class QueryAuthError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "QueryAuthError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "QueryAuthError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The SSH login name whose authentication failed. */
  readonly username: string;

  constructor(username: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.username = username;
  }
}
