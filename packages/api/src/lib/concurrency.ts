/**
 * Run an async mapper over a list with a bounded number in flight.
 *
 * Written for the QBO Gemini passes, which chunk transactions 150 at a time
 * and then awaited each chunk in a `for` loop — so 1,500 uncategorized rows
 * meant ten sequential model calls inside one HTTP request. The chunks are
 * independent (each prompt carries the whole chart of accounts plus its own
 * rows), so the sequencing bought nothing.
 *
 * Bounded rather than Promise.all: the provider rate-limits, and firing
 * twenty calls at once trades a slow response for a failed one.
 *
 * Results keep input order regardless of completion order. The first
 * rejection propagates, matching the `for await` behaviour it replaces.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  return results
}
