/** Errors whose message is safe and useful to show the API caller. */
export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
