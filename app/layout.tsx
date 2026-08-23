import type { Metadata } from 'next'
import { Archivo, JetBrains_Mono } from 'next/font/google'
import './globals.css'

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--fuente-display',
  axes: ['wdth'],
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--fuente-mono',
})

export const metadata: Metadata = {
  title: 'SDR',
  description: 'Prospección en frío, cualificación y agendado automáticos.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${archivo.variable} ${mono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
