import "@testing-library/jest-dom/vitest";

// survey-core builds a ResizeObserver when a Survey mounts
// (ScrollViewModel.setRootElement <- Scroll.componentDidMount); jsdom 25 ships
// none. A no-op is enough here: no test measures layout.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
