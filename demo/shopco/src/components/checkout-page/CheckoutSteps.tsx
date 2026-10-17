import React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const CHECKOUT_STEPS = ["Information", "Payment", "Confirmation"] as const;

type CheckoutStepsProps = {
  current: number;
};

const CheckoutSteps = ({ current }: CheckoutStepsProps) => {
  return (
    <ol className="flex items-center gap-2 sm:gap-3 mb-6 text-sm">
      {CHECKOUT_STEPS.map((step, idx) => (
        <li
          key={step}
          aria-current={idx === current ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 sm:gap-3",
            idx > current && "text-muted-foreground"
          )}
        >
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
              idx <= current && "bg-primary border-primary text-primary-foreground"
            )}
          >
            {idx < current ? <Check className="size-3.5" /> : idx + 1}
          </span>
          <span
            className={cn(
              idx === current ? "font-medium" : "hidden sm:inline"
            )}
          >
            {step}
          </span>
          {idx < CHECKOUT_STEPS.length - 1 && (
            <span className="h-px w-4 sm:w-12 bg-border" aria-hidden />
          )}
        </li>
      ))}
    </ol>
  );
};

export default CheckoutSteps;
