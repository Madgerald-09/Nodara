export function createSingleFlightGate() {
  let inFlight = false
  return {
    tryEnter() {
      if (inFlight) return false
      inFlight = true
      return true
    },
    release() { inFlight = false },
  }
}
