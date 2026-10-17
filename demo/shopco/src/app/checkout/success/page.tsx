"use client";

import React from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import BreadcrumbCheckout from "@/components/checkout-page/BreadcrumbCheckout";
import CheckoutSteps from "@/components/checkout-page/CheckoutSteps";
import NoOrder from "@/components/checkout-page/NoOrder";
import OrderSummary from "@/components/checkout-page/OrderSummary";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAppSelector } from "@/lib/hooks/redux";
import { RootState } from "@/lib/store";
import { CARD_BRAND_LABELS } from "@/lib/payment";
import { cn } from "@/lib/utils";
import { integralCF } from "@/styles/fonts";

export default function CheckoutSuccessPage() {
  const order = useAppSelector((state: RootState) => state.checkout.lastOrder);

  if (!order || order.status !== "paid") return <NoOrder />;

  const { shipping, payment } = order;

  return (
    <main className="pb-20">
      <div className="max-w-frame mx-auto px-4 xl:px-0">
        <BreadcrumbCheckout current="Confirmation" />
        <CheckoutSteps current={2} />
        <div className="flex flex-col lg:flex-row gap-5 items-start">
          <Card className="w-full rounded-[20px] border-black/10 shadow-none">
            <CardHeader className="items-center text-center gap-2">
              <CircleCheck className="size-14" strokeWidth={1.5} />
              <CardTitle
                className={cn([
                  integralCF.className,
                  "text-[28px] md:text-[36px] uppercase",
                ])}
              >
                Payment confirmed
              </CardTitle>
              <CardDescription className="text-base">
                Thanks, {shipping.fullName.split(" ")[0]}! A confirmation was
                sent to {shipping.email}.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Separator />
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Order number</dt>
                  <dd className="font-medium">{order.id}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Date</dt>
                  <dd className="font-medium">
                    {new Date(order.createdAt).toLocaleString()}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Paid with</dt>
                  <dd className="font-medium">
                    {CARD_BRAND_LABELS[payment.brand]} ending in {payment.last4}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Transaction</dt>
                  <dd className="font-medium break-all">
                    {payment.transactionId}
                  </dd>
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <dt className="text-muted-foreground">Shipping to</dt>
                  <dd className="font-medium">
                    {shipping.fullName}, {shipping.address}, {shipping.city}{" "}
                    {shipping.postalCode}, {shipping.country}
                  </dd>
                </div>
              </dl>
              <Separator />
              <Button
                asChild
                className="text-sm md:text-base font-medium rounded-full w-full h-[54px] md:h-[60px]"
              >
                <Link href="/shop">Continue Shopping</Link>
              </Button>
            </CardContent>
          </Card>
          <div className="w-full lg:max-w-[505px]">
            <OrderSummary
              items={order.items}
              subtotal={order.subtotal}
              discount={order.discount}
              total={order.total}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
