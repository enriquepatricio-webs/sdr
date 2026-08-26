import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Salida autocontenida, pero SOLO fuera de Vercel.
   *
   * Deja en `.next/standalone` un servidor con solo las dependencias que se
   * usan de verdad, así que en un servidor propio no hace falta llevarse
   * `node_modules` entero.
   *
   * Ponerla siempre no vale: Vercel no la ignora, se rompe con ella. Su paso
   * final busca `.next/next-server.js.nft.json`, que el modo autocontenido no
   * genera, y la compilación entera falla con un ENOENT que no menciona
   * `standalone` por ninguna parte.
   *
   * Importa más de lo que parece: mientras el proyecto de Vercel siga vivo es
   * la marcha atrás del traslado, y una marcha atrás que no compila no es una
   * marcha atrás. `VERCEL` la define su propio compilador.
   */
  output: process.env.VERCEL ? undefined : "standalone",
};

export default nextConfig;
