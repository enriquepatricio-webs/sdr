import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Salida autocontenida, para poder correr fuera de Vercel.
   *
   * Deja en `.next/standalone` un servidor con solo las dependencias que de
   * verdad se usan, así que en el servidor propio no hace falta instalar nada
   * ni llevarse `node_modules` entero. Vercel ignora esta opción, de modo que
   * ponerla no cambia nada de lo que ya funciona.
   */
  output: "standalone",
};

export default nextConfig;
