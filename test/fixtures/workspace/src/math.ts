export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function average(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total = total + values[i];
  }
  return total / values.length;
}

export function add(a: number, b: number): number {

}
