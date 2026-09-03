/**
 * Purchase-link builder — the SINGLE touchpoint for card shop URLs.
 * Plain search links for now; when the Cardmarket/TCGplayer affiliate
 * accounts are approved, inject the affiliate params here and nowhere else.
 */

export function cardmarketUrl(cardName: string): string {
  return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(cardName)}`
}

export function tcgplayerUrl(cardName: string): string {
  return `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(cardName)}`
}
