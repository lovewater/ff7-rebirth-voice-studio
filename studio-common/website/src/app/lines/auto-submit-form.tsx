"use client";

import type { FormHTMLAttributes } from "react";

function liveSubmit(el: EventTarget | null) {
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return el.type === "checkbox" || el.type === "radio" || el.type === "number";
  }
  return false;
}

export function AutoSubmitForm({
  children,
  ...props
}: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form
      {...props}
      onChange={(e) => {
        props.onChange?.(e);
        if (liveSubmit(e.target)) e.currentTarget.requestSubmit();
      }}
      onBlur={(e) => {
        props.onBlur?.(e);
        const t = e.target;
        if (t instanceof HTMLInputElement && (t.type === "text" || t.type === "number")) {
          e.currentTarget.requestSubmit();
        }
      }}
    >
      {children}
    </form>
  );
}
