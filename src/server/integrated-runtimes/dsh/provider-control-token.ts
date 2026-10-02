// DSH can receive a provider's printable spelling of a control token as
// ordinary text. Filter the one confirmed spelling before Product streaming
// and transcript persistence, including when it straddles native chunks.
const DSML_CONTROL_TOKEN = '｜｜DSML｜｜';
const REPLACEMENT = '[invalid provider control token]';

export class ProviderControlTokenFilter {
  private pending = '';
  private matches = 0;

  accept(chunk: string): string {
    const input = this.pending + chunk;
    this.pending = '';
    let output = '';
    for (let index = 0; index < input.length;) {
      if (input.startsWith(DSML_CONTROL_TOKEN, index)) {
        output += REPLACEMENT;
        this.matches++;
        index += DSML_CONTROL_TOKEN.length;
      } else if (DSML_CONTROL_TOKEN.startsWith(input.slice(index))) {
        this.pending = input.slice(index);
        break;
      } else {
        output += input[index];
        index++;
      }
    }
    return output;
  }

  finish(): { text: string; matches: number } {
    const result = { text: this.pending, matches: this.matches };
    this.pending = '';
    this.matches = 0;
    return result;
  }
}
