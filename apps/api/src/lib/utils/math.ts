function isClose(a: number, b: number, tolerance = 0) {
  return Math.abs(a - b) < tolerance;
}

export { isClose };
