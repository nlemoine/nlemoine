declare module 'twig' {
  export interface TwigTemplate {
    render(context?: Record<string, unknown>): string
    renderAsync(context?: Record<string, unknown>): Promise<string>
  }
  export interface TwigStatic {
    twig(
      params: { data: string; rethrow?: boolean } | { path: string; rethrow?: boolean },
    ): TwigTemplate
    extendFilter(
      name: string,
      definition: (value: unknown, params?: unknown[]) => unknown,
    ): void
    extendFunction(name: string, definition: (...args: unknown[]) => unknown): void
  }
  const Twig: TwigStatic
  export default Twig
}
