/**
 * Where sign-in returns to. Only a path inside the app is honoured — never
 * another origin ("//evil.example", "https://…") — so ?next= cannot be used
 * to bounce a signed-in person off the site.
 */
export function safeNext(next: string | null): string | null {
  return next && /^\/app(\/|\?|$)/.test(next) ? next : null
}
