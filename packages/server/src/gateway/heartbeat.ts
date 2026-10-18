/**
 * Transport-level liveness: pings every socket on an interval and terminates
 * the ones that did not answer the previous ping.
 *
 * A peer that vanishes without a close frame — a laptop lid, a dropped Wi-Fi
 * link — otherwise keeps its socket, its seat in the connection caps and its
 * room subscription until the OS gives up on the TCP connection, which can
 * take many minutes.
 */

/** The slice of a `ws` socket the heartbeat needs. */
export interface Pingable {
  ping(): void;
  terminate(): void;
  onPong(listener: () => void): void;
}

export class Heartbeat {
  /** Whether each socket has answered since the last sweep. */
  private readonly alive = new Map<Pingable, boolean>();

  get size(): number {
    return this.alive.size;
  }

  track(socket: Pingable): void {
    this.alive.set(socket, true);
    socket.onPong(() => {
      if (this.alive.has(socket)) this.alive.set(socket, true);
    });
  }

  untrack(socket: Pingable): void {
    this.alive.delete(socket);
  }

  /**
   * One beat. Call on an interval; a socket survives as long as it answers
   * within one interval.
   *
   * @returns How many sockets were terminated.
   */
  sweep(): number {
    let terminated = 0;
    for (const [socket, answered] of this.alive) {
      if (!answered) {
        this.alive.delete(socket);
        socket.terminate();
        terminated += 1;
        continue;
      }
      this.alive.set(socket, false);
      socket.ping();
    }
    return terminated;
  }
}
