export const PHASE_A_COMMANDS = ['scan', 'history', 'compare', 'config', 'doctor'] as const;
export const BLOCKED_PHASE_A_COMMANDS = ['release-check', 'prompts'] as const;

export class FeatureDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureDisabledError';
  }
}

export class UnsupportedPhaseError extends Error {
  readonly exitCode = 78;

  constructor(command: string) {
    super(`Command unavailable in current phase: ${command}.`);
    this.name = 'UnsupportedPhaseError';
  }
}

export function assertPhaseACommandAllowed(command: string): void {
  if ((BLOCKED_PHASE_A_COMMANDS as readonly string[]).includes(command)) {
    throw new UnsupportedPhaseError(command);
  }
}
