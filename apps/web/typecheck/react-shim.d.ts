/**
 * A minimal stand-in for @types/react, used only by `typecheck:offline` when the
 * real types cannot be installed. Hooks, components and events are typed;
 * attributes of HTML elements are not checked. The real build uses @types/react.
 */
declare module 'react' {
  export type Key = string | number | bigint;
  export type ReactElement = { readonly type: unknown; readonly props: unknown; readonly key: Key | null };
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export type CSSProperties = { [property: string]: string | number | undefined };
  export type SetStateAction<S> = S | ((previous: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export type MutableRefObject<T> = { current: T };
  export type RefObject<T> = { readonly current: T | null };
  export type Context<T> = { Provider: (props: { value: T; children?: ReactNode }) => ReactNode; readonly _type?: T };

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useReducer<S, A, I>(reducer: (state: S, action: A) => S, initialArg: I, init: (arg: I) => S): [S, Dispatch<A>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T>;
  export function useId(): string;
  export function createContext<T>(value: T): Context<T>;
  export function useContext<T>(context: Context<T>): T;
  export function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T;
  export function memo<P>(component: (props: P) => ReactNode): (props: P) => ReactNode;
  export const StrictMode: (props: { children?: ReactNode }) => ReactNode;

  type Synthetic<T, E extends Event> = Omit<E, 'currentTarget' | 'target'> & { currentTarget: T; target: EventTarget | null; nativeEvent: E };
  export type SyntheticEvent<T = Element> = Synthetic<T, Event>;
  export type MouseEvent<T = Element> = Synthetic<T, globalThis.MouseEvent>;
  export type PointerEvent<T = Element> = Synthetic<T, globalThis.PointerEvent>;
  export type KeyboardEvent<T = Element> = Synthetic<T, globalThis.KeyboardEvent>;
  export type DragEvent<T = Element> = Omit<Synthetic<T, globalThis.DragEvent>, 'dataTransfer'> & { dataTransfer: DataTransfer };
  export type FocusEvent<T = Element> = Omit<Synthetic<T, globalThis.FocusEvent>, 'target'> & { target: EventTarget & T };
  export type ChangeEvent<T = Element> = Omit<Synthetic<T, Event>, 'target'> & { target: EventTarget & T };
  export type FormEvent<T = Element> = Synthetic<T, Event>;

  type Attributes = { [attribute: string]: unknown; className?: string; children?: ReactNode; title?: string; style?: CSSProperties };
  export type ButtonHTMLAttributes<T> = Attributes & { type?: 'button' | 'submit' | 'reset'; disabled?: boolean; onClick?: (event: MouseEvent<T>) => void };
  export type AnchorHTMLAttributes<T> = Attributes & { href?: string; onClick?: (event: MouseEvent<T>) => void };
}

declare module 'react/jsx-runtime' {
  import type { ChangeEvent, DragEvent, FocusEvent, FormEvent, Key, KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode, SyntheticEvent } from 'react';
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
  export namespace JSX {
    type Element = ReactElement;
    type ElementType = string | ((props: never) => ReactNode);
    type IntrinsicAttributes = { key?: Key | null };
    type ElementChildrenAttribute = { children: unknown };
    /** Form controls share one target type here, so `event.target.value` and `.checked` are typed. */
    type FormTarget = HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
    // Method signatures keep handlers bivariant, as in @types/react.
    type Handlers<T> = {
      onChange?(event: ChangeEvent<T>): void;
      onInput?(event: ChangeEvent<T>): void;
      onClick?(event: MouseEvent<T>): void;
      onContextMenu?(event: MouseEvent<T>): void;
      onSubmit?(event: FormEvent<T>): void;
      onKeyDown?(event: KeyboardEvent<T>): void;
      onKeyUp?(event: KeyboardEvent<T>): void;
      onFocus?(event: FocusEvent<T>): void;
      onBlur?(event: FocusEvent<T>): void;
      onSelect?(event: SyntheticEvent<T>): void;
      onPointerDown?(event: PointerEvent<T>): void;
      onPointerMove?(event: PointerEvent<T>): void;
      onPointerUp?(event: PointerEvent<T>): void;
      onPointerCancel?(event: PointerEvent<T>): void;
      onDragStart?(event: DragEvent<T>): void;
      onDragOver?(event: DragEvent<T>): void;
      onDrop?(event: DragEvent<T>): void;
      onClose?(event: SyntheticEvent<T>): void;
      onCancel?(event: SyntheticEvent<T>): void;
    };
    type Props<T> = Handlers<T> & { [attribute: string]: unknown; key?: Key | null; ref?: unknown };
    type IntrinsicElements = {
      [element: string]: Props<HTMLElement>;
      input: Props<FormTarget>;
      textarea: Props<FormTarget>;
      select: Props<FormTarget>;
      form: Props<HTMLFormElement>;
      button: Props<HTMLButtonElement>;
      div: Props<HTMLDivElement>;
      dialog: Props<HTMLDialogElement>;
      a: Props<HTMLAnchorElement>;
    };
  }
}

declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export function createRoot(container: Element): { render: (node: ReactNode) => void };
}

declare module '*.css' {}
