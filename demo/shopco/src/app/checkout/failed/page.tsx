"use client";

import React from "react";
import Link from "next/link";
import { CircleAlert, CircleX } from "lucide-react";
import BreadcrumbCheckout from "@/components/checkout-page/BreadcrumbCheckout";
import CheckoutSteps from "@/components/checkout-page/CheckoutSteps";
import NoOrder from "@/components/checkout-page/NoOrder";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppSelector } from "@/lib/hooks/redux";
import { RootState } from "@/lib/store";
import { CARD_BRAND_LABELS } from "@/lib/payment";
import { cn } from "@/lib/utils";
import { integralCF } from "@/styles/fonts";

export default function CheckoutFailedPage() {
  const order = useAppSelector((state: RootState) => state.checkout.lastOrder);

  if (!order || order.status !== "failed" || !order.failure) return <NoOrder />;

  return (
    <main className="pb-20">
      <div className="max-w-frame mx-auto px-4 xl:px-0">
        <BreadcrumbCheckout current="Payment failed" />
        <CheckoutSteps current={1} />
        <Card className="mx-auto w-full max-w-2xl rounded-[20px] border-black/10 shadow-none">
          <CardHeader className="items-center text-center gap-2">
            <CircleX className="size-14 text-destructive" strokeWidth={1.5} />
            <CardTitle
              className={cn([
                integralCF.className,
                "text-[28px] md:text-[36px] uppercase",
              ])}
            >
              Payment failed
            </CardTitle>
            <CardDescription className="text-base">
              Your card was not charged and your cart is still saved.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <CircleAlert className="size-4" />
              <AlertTitle className="flex items-center gap-2">
                {CARD_BRAND_LABELS[order.payment.brand]} ending in{" "}
                {order.payment.last4}
                <Badge variant="destructive">{order.failure.code}</Badge>
              </AlertTitle>
              <AlertDescription>
                {order.failure.message} Try another card or contact your bank.
              </AlertDescription>
            </Alert>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-bold">${order.total}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Reference</span>
              <span className="font-medium">{order.id}</span>
            </div>
          </CardContent>
          <CardFooter className="flex flex-col sm:flex-row gap-3">
            <Button
              asChild
              className="text-sm md:text-base font-medium rounded-full w-full h-[54px]"
            >
              <Link href="/checkout">Try Again</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="text-sm md:text-base font-medium rounded-full w-full h-[54px]"
            >
              <Link href="/cart">Back to Cart</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
