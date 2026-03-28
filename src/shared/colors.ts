import chalk, { type ChalkInstance } from "chalk";

/**
 * A rotating palette of distinct terminal colors for N machines.
 * Each machine gets a consistent color based on join order.
 * Supports unlimited machines — cycles through the palette.
 */
const PALETTE: ChalkInstance[] = [
  chalk.cyan,
  chalk.magenta,
  chalk.yellow,
  chalk.green,
  chalk.blue,
  chalk.red,
  chalk.hex("#FF8800"), // orange
  chalk.hex("#00DDAA"), // teal
  chalk.hex("#DD55FF"), // purple
  chalk.hex("#FFDD00"), // gold
  chalk.hex("#00AAFF"), // sky blue
  chalk.hex("#FF5577"), // coral
];

const PALETTE_BOLD: ChalkInstance[] = PALETTE.map((c) => c.bold);

export class MachineColorMap {
  private colorIndex = new Map<string, number>();
  private nextIndex = 0;

  /**
   * Assign or retrieve a color for a machine by its peerId.
   */
  getColor(peerId: string): ChalkInstance {
    if (!this.colorIndex.has(peerId)) {
      this.colorIndex.set(peerId, this.nextIndex);
      this.nextIndex++;
    }
    const idx = this.colorIndex.get(peerId)!;
    return PALETTE[idx % PALETTE.length];
  }

  /**
   * Get the bold variant for headers/labels.
   */
  getBoldColor(peerId: string): ChalkInstance {
    if (!this.colorIndex.has(peerId)) {
      this.colorIndex.set(peerId, this.nextIndex);
      this.nextIndex++;
    }
    const idx = this.colorIndex.get(peerId)!;
    return PALETTE_BOLD[idx % PALETTE_BOLD.length];
  }

  /**
   * Format a hostname tag like "(work-laptop)" in the machine's color.
   */
  formatTag(peerId: string, label: string): string {
    return this.getBoldColor(peerId)(`(${label})`);
  }

  /**
   * Format a full chat line: "(hostname) message" with color.
   */
  formatMessage(peerId: string, label: string, message: string): string {
    const tag = this.formatTag(peerId, label);
    const text = this.getColor(peerId)(message);
    return `${tag} ${text}`;
  }

  /**
   * Get the assigned color index for a peer (useful for legends).
   */
  getColorName(peerId: string): string {
    const names = [
      "cyan", "magenta", "yellow", "green", "blue", "red",
      "orange", "teal", "purple", "gold", "sky-blue", "coral",
    ];
    const idx = this.colorIndex.get(peerId) ?? 0;
    return names[idx % names.length];
  }

  /**
   * Get count of registered machines.
   */
  get size(): number {
    return this.colorIndex.size;
  }
}
