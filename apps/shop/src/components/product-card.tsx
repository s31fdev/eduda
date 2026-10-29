import { Badge } from '@repo/ui/components/badge'
import { Card, CardContent } from '@repo/ui/components/card'
import Image from 'next/image'
import Link from 'next/link'
import { CoinPrice } from './coin-price'

export interface CatalogProduct {
  id: number
  name: string
  description: string | null
  imageUrl: string
  price: number
  quantity: number
  category: { id: number; name: string }
}

export function ProductCard({ product }: { product: CatalogProduct }) {
  const outOfStock = product.quantity <= 0

  return (
    <Link href={`/shop/${product.id}`} className="group">
      <Card className="h-full overflow-hidden py-0 transition-colors group-hover:border-current/20">
        <div className="bg-muted relative aspect-square">
          {product.imageUrl ? (
            <Image
              src={product.imageUrl}
              alt={product.name}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 50vw, 200px"
            />
          ) : null}
          {outOfStock && (
            <div className="bg-background/70 absolute inset-0 flex items-center justify-center">
              <Badge variant="secondary">Нет в наличии</Badge>
            </div>
          )}
        </div>
        {/* Колонка на всю высоту карточки: название занимает ровно две строки,
            цена прижата к низу — иначе в ряду они пляшут по вертикали. */}
        <CardContent className="flex flex-1 flex-col space-y-1 p-3">
          <div className="line-clamp-2 min-h-10 text-sm font-medium">{product.name}</div>
          <div className="text-muted-foreground text-xs">{product.category.name}</div>
          <div className="mt-auto flex items-center justify-between pt-1">
            <CoinPrice value={product.price} />
            {!outOfStock && (
              <span className="text-muted-foreground text-xs">{product.quantity} шт.</span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
