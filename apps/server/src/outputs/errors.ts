export type OutputErrorCode =
  | 'not_found'
  | 'anchor_not_found'
  | 'anchor_ambiguous'
  | 'version_moved'
  | 'invalid_edit';

export class OutputError extends Error {
  constructor(
    readonly code: OutputErrorCode,
    message: string,
  ) {
    super(message);
  }
}
