import { CoinPrice } from '@/src/components/coin-price'
import { CatalogProduct } from '@/src/components/product-card'
import { AddToCartButton } from '@/src/features/cart/components/add-to-cart-button'
import { Badge } from '@repo/ui/components/badge'
import { Button } from '@repo/ui/components/button'
import { Card, CardContent } from '@repo/ui/components/card'
import { Separator } from '@repo/ui/components/separator'
import { ChevronLeft } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

export function ProductDetail({ product, inCart }: { product: CatalogProduct; inCart: number }) {
  const outOfStock = product.quantity <= 0

  return (
    <div className="space-y-6">
      <Button variant="ghost" className="-ml-2" nativeButton={false} render={<Link href="/shop" />}>
        <ChevronLeft />В магазин
      </Button>

      <Card className="overflow-hidden py-0">
        <div className="bg-muted relative aspect-square sm:aspect-[2/1]">
          {product.imageUrl ? (
            <Image
              src={product.imageUrl}
              alt={product.name}
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 768px"
            />
          ) : null}
        </div>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-1">
            <Badge variant="outline">{product.category.name}</Badge>
            <h1 className="text-xl font-semibold tracking-tight">{product.name}</h1>
          </div>

          {product.description && (
            <p className="text-muted-foreground text-sm">{product.description}</p>
          )}

          <Separator />

          <div className="flex items-center justify-between">
            <CoinPrice value={product.price} size="lg" />
            <span className="text-muted-foreground text-sm">
              {outOfStock ? 'Нет в наличии' : `Осталось ${product.quantity} шт.`}
            </span>
          </div>

          <AddToCartButton shopItemId={product.id} available={product.quantity} inCart={inCart} />
        </CardContent>
      </Card>
    </div>
  )
}
