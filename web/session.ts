export type LandingSession = {
  spaceKey: string | null;
  copied: boolean;
};

export function emptySession(): LandingSession {
  return { spaceKey: null, copied: false };
}

export function sessionAfterGenerate(_session: LandingSession, spaceKey: string): LandingSession {
  return { spaceKey, copied: false };
}

export function sessionAfterCopy(session: LandingSession): LandingSession {
  if (session.spaceKey === null) return session;
  return { spaceKey: session.spaceKey, copied: true };
}

export function shouldWarnBeforeUnload(session: LandingSession): boolean {
  return session.spaceKey !== null && !session.copied;
}
