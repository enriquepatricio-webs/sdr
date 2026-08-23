/** Pruebas del lector de CSV. `npm run test:csv`. */
import assert from 'node:assert/strict'
import { adivinarMapeo, detectarSeparador, parsearCsv } from './csv'

let ok = 0
const fallos: string[] = []
function prueba(nombre: string, fn: () => void) {
  try { fn(); ok++ } catch (e) { fallos.push(`${nombre}\n    ${(e as Error).message.split('\n')[0]}`) }
}

prueba('CSV básico', () => {
  const f = parsearCsv('nombre,empresa\nAna,Acme\nBeto,Globex')
  assert.equal(f.length, 2)
  assert.deepEqual(f[0], { nombre: 'Ana', empresa: 'Acme' })
})

prueba('una coma dentro de comillas NO parte el campo', () => {
  const f = parsearCsv('nombre,empresa\nAna,"Acme, S.L."')
  assert.equal(f[0].empresa, 'Acme, S.L.')
})

prueba('comillas escapadas', () => {
  const f = parsearCsv('nombre,nota\nAna,"dijo ""vale"" y colgó"')
  assert.equal(f[0].nota, 'dijo "vale" y colgó')
})

prueba('salto de línea dentro de un campo entrecomillado', () => {
  const f = parsearCsv('nombre,bio\nAna,"linea uno\nlinea dos"\nBeto,x')
  assert.equal(f.length, 2)
  assert.equal(f[0].bio, 'linea uno\nlinea dos')
  assert.equal(f[1].nombre, 'Beto')
})

prueba('finales de línea de Windows', () => {
  const f = parsearCsv('a,b\r\n1,2\r\n3,4')
  assert.equal(f.length, 2)
  assert.deepEqual(f[1], { a: '3', b: '4' })
})

prueba('BOM de Excel', () => {
  const f = parsearCsv('﻿nombre,empresa\nAna,Acme')
  assert.deepEqual(Object.keys(f[0]), ['nombre', 'empresa'])
})

prueba('separador punto y coma (Excel en español)', () => {
  assert.equal(detectarSeparador('nombre;empresa;email'), ';')
  const f = parsearCsv('nombre;empresa\nAna;Acme')
  assert.equal(f[0].empresa, 'Acme')
})

prueba('el separador no se confunde por comas dentro de comillas', () => {
  assert.equal(detectarSeparador('nombre;"Acme, S.L., y otros";email'), ';')
})

prueba('tabuladores', () => {
  assert.equal(detectarSeparador('nombre\tempresa\temail'), '\t')
})

prueba('filas vacías y columnas de menos', () => {
  const f = parsearCsv('a,b,c\n1,2\n\n3,4,5\n')
  assert.equal(f.length, 2)
  assert.equal(f[0].c, '')
})

prueba('un CSV sin filas de datos devuelve nada', () => {
  assert.deepEqual(parsearCsv('a,b,c'), [])
  assert.deepEqual(parsearCsv(''), [])
})

prueba('se recortan los espacios', () => {
  const f = parsearCsv('nombre , empresa\n Ana , Acme ')
  assert.equal(f[0].nombre, 'Ana')
})

prueba('el mapeo automático acierta con cabeceras en español', () => {
  const m = adivinarMapeo(['Nombre completo', 'Empresa', 'Correo electrónico', 'Perfil de LinkedIn'])
  assert.equal(m.fullName, 'Nombre completo')
  assert.equal(m.company, 'Empresa')
  assert.equal(m.email, 'Correo electrónico')
  assert.equal(m.linkedinUrl, 'Perfil de LinkedIn')
})

prueba('el mapeo automático acierta con cabeceras en inglés', () => {
  const m = adivinarMapeo(['Full Name', 'Company', 'Email', 'LinkedIn URL', 'Job Title'])
  assert.equal(m.fullName, 'Full Name')
  assert.equal(m.headline, 'Job Title')
  assert.equal(m.linkedinUrl, 'LinkedIn URL')
})

prueba('una columna no se asigna a dos campos a la vez', () => {
  const m = adivinarMapeo(['Email', 'LinkedIn URL'])
  assert.equal(m.email, 'Email')
  assert.notEqual(m.linkedinUrl, 'Email')
})

console.log(`\n${ok} comprobaciones correctas`)
if (fallos.length) {
  console.error(`\n${fallos.length} FALLOS:\n`)
  for (const f of fallos) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log('Lector de CSV verificado.')
