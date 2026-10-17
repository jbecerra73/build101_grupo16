"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TbBasketExclamation } from "react-icons/tb";
import BreadcrumbCheckout from "@/components/checkout-page/BreadcrumbCheckout";
import CheckoutSteps from "@/components/checkout-page/CheckoutSteps";
import OrderSummary from "@/components/checkout-page/OrderSummary";
import PaymentForm, {
  PaymentDetails,
} from "@/components/checkout-page/PaymentForm";
import ShippingForm from "@/components/checkout-page/ShippingForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { clearCart } from "@/lib/features/carts/cartsSlice";
import {
  Order,
  saveShipping,
  setLastOrder,
  ShippingInfo,
} from "@/lib/features/checkout/checkoutSlice";
import { useAppDispatch, useAppSelector } from "@/lib/hooks/redux";
import { RootState } from "@/lib/store";
import {
  digitsOnly,
  generateOrderId,
  getCardBrand,
  simulatePayment,
} from "@/lib/payment";
import { cn } from "@/lib/utils";
import { integralCF } from "@/styles/fonts";

export default function CheckoutPage() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { cart, totalPrice, adjustedTotalPrice } = useAppSelector(
    (state: RootState) => state.carts
  );
  const shipping = useAppSelector((state: RootState) => state.checkout.shipping);
  // Returning shoppers with saved shipping info start on the payment step
  const [chosenStep, setStep] = useState<"information" | "payment" | null>(
    null
  );
  const step = chosenStep ?? (shipping ? "payment" : "information");
  // Stays true after the payment resolves so the page does not flash the
  // empty cart state while navigating to the result page
  const [processing, setProcessing] = useState(false);

  const subtotal = totalPrice;
  const discount = Math.round(totalPrice - adjustedTotalPrice);
  const total = Math.round(adjustedTotalPrice);

  const handleShippingSubmit = (values: ShippingInfo) => {
    dispatch(saveShipping(values));
    setStep("payment");
  };

  const handlePay = async (details: PaymentDetails) => {
    if (!cart || !shipping) return;
    setProcessing(true);

    const result = await simulatePayment(details.cardNumber);
    const order: Order = {
      id: generateOrderId(),
      status: result.ok ? "paid" : "failed",
      createdAt: new Date().toISOString(),
      items: cart.items,
      subtotal,
      discount,
      total,
      shipping,
      payment: {
        brand: getCardBrand(details.cardNumber),
        last4: digitsOnly(details.cardNumber).slice(-4),
        transactionId: result.ok ? result.transactionId : undefined,
      },
      failure: result.ok
        ? undefined
        : { code: result.code, message: result.message },
    };

    dispatch(setLastOrder(order));
    if (result.ok) {
      dispatch(clearCart());
      router.push("/checkout/success");
    } else {
      router.push("/checkout/failed");
    }
  };

  if (!cart || cart.items.length === 0) {
    return (
      <main className="pb-20">
        {!processing && (
          <div className="flex items-center flex-col text-gray-300 mt-32">
            <TbBasketExclamation strokeWidth={1} className="text-6xl" />
            <span className="block mb-4">
              Your cart is empty, nothing to check out.
            </span>
            <Button className="rounded-full w-24" asChild>
              <Link href="/shop">Shop</Link>
            </Button>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="pb-20">
      <div className="max-w-frame mx-auto px-4 xl:px-0">
        <BreadcrumbCheckout current="Checkout" />
        <h2
          className={cn([
            integralCF.className,
            "font-bold text-[32px] md:text-[40px] text-black uppercase mb-5 md:mb-6",
          ])}
        >
          checkout
        </h2>
        <CheckoutSteps current={step === "information" ? 0 : 1} />
        <div className="flex flex-col lg:flex-row gap-5 items-start">
          <div className="w-full flex flex-col gap-5">
            {step === "information" || !shipping ? (
              <ShippingForm
                defaultValues={shipping}
                onSubmit={handleShippingSubmit}
              />
            ) : (
              <>
                <Card className="w-full rounded-[20px] border-black/10 shadow-none">
                  <CardContent className="flex items-start justify-between gap-4 p-5 md:px-6">
                    <div className="flex flex-col gap-1 text-sm">
                      <span className="font-medium">Ship to</span>
                      <span className="text-muted-foreground">
                        {shipping.fullName} · {shipping.email}
                      </span>
                      <span className="text-muted-foreground">
                        {shipping.address}, {shipping.city}{" "}
                        {shipping.postalCode}, {shipping.country}
                      </span>
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      disabled={processing}
                      onClick={() => setStep("information")}
                    >
                      Change
                    </Button>
                  </CardContent>
                </Card>
                <PaymentForm
                  total={total}
                  processing={processing}
                  defaultName={shipping.fullName}
                  onSubmit={handlePay}
                />
              </>
            )}
          </div>
          <div className="w-full lg:max-w-[505px]">
            <OrderSummary
              items={cart.items}
              subtotal={subtotal}
              discount={discount}
              total={total}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
