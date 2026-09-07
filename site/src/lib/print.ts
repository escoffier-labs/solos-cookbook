/** The print route is an artifact build input, never a normal public page. */
export function shouldBuildBook(raw: string | undefined): boolean {
  return raw === '1';
}
