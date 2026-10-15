/**
 * The connection a ServerQuery client talks over.
 *
 * ServerQuery is a line protocol on three transports: raw TCP (10011), SSH
 * (10022) and, on TeamSpeak 6, an HTTP WebQuery (10080) that frames each
 * command as a request. The client depends on this interface only, so each
 * transport is a separate piece, and a test or a proxy can supply its own.
 */
export interface QueryTransport {
  /** Send one command line; the transport adds the line terminator. */
  send(line: string): Promise<void>;
  /**
   * Called with each line the server sends, without its terminator, in the
   * order received.
   */
  onLine: ((line: string) => void) | null;
  /** Called once when the connection ends, with the cause unless it was `close()`. */
  onClose: ((error: Error | undefined) => void) | null;
  /** End the connection. */
  close(): Promise<void>;
}
