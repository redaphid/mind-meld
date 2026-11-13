// The paraphrase stratum tests meaning without shared words, so "shared" must
// be generous: a query word counts as reused when it shares a 5-letter prefix
// with any shown word (a crude stem: "migrating" ~ "migration"), or matches a
// shorter word whole.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both
  but by can could did do does doing down during each few for from further had has have having he her here hers
  him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our
  out over own same she should so some such than that the their them then there these they this those through to
  too under until up very was we were what when where which while who whom why will with would you your yours
  also get got make made use used using way thing things one two find found need want like work working session
  sessions conversation conversations time something someone where whatever etc via per`.split(/\s+/)
)

const STEM = 5

const stem = (word: string) => word.slice(0, STEM)

export const contentWords = (text: string): string[] =>
  [...new Set(text.toLowerCase().split(/[^a-z0-9]+/))].filter((w) => w.length >= 3 && !STOPWORDS.has(w))

// Query words that also appear, stemmed, anywhere in the shown text.
export const sharedContentWords = (query: string, shown: string): string[] => {
  const shownWords = contentWords(shown)
  const shownStems = new Set(shownWords.filter((w) => w.length >= STEM).map(stem))
  const shownWhole = new Set(shownWords)
  return contentWords(query).filter((w) => shownWhole.has(w) || (w.length >= STEM && shownStems.has(stem(w))))
}
