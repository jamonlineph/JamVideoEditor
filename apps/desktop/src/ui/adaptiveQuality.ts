const LOWEST_AUTO = 360;
const STEP = 90;

/** Tracks sustained deadline misses and recovers one size at a time after stable playback. */
export class AdaptivePreviewQuality {
  private ceiling = 720;
  private current = this.ceiling;
  private automatic = true;
  private samples = 0;
  private misses = 0;
  private stable = 0;

  get shortSide() {
    return this.current;
  }

  configure(ceiling: number, automatic: boolean) {
    if (this.ceiling === ceiling && this.automatic === automatic) return;
    const atCeiling = this.current === this.ceiling;
    this.ceiling = ceiling;
    this.automatic = automatic;
    this.current = automatic && !atCeiling ? Math.min(ceiling, this.current) : ceiling;
    this.resetSamples();
  }

  resetSamples() {
    this.samples = 0;
    this.misses = 0;
    this.stable = 0;
  }

  observe(renderMs: number, deadlineMs: number, skipped: boolean) {
    if (!this.automatic) return;
    const floor = Math.min(LOWEST_AUTO, this.ceiling);
    const late = skipped || renderMs > deadlineMs * 1.1;
    this.samples++;
    if (late) this.misses++;
    this.stable = !late && renderMs < deadlineMs * 0.7 ? this.stable + 1 : 0;

    if (this.samples >= 16) {
      const reduce = this.misses >= 8 && this.current > floor;
      this.samples = 0;
      this.misses = 0;
      if (reduce) {
        this.current = Math.max(floor, Math.floor(this.current * 0.8 / STEP) * STEP);
        this.resetSamples();
      }
    }
    // Slow upward changes avoid toggling levels near the frame deadline.
    if (this.stable >= 240 && this.current < this.ceiling) {
      this.current = Math.min(this.ceiling, this.current + STEP);
      this.resetSamples();
    }
  }
}
