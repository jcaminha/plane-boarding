# Simulador de Embarque

Aplicação web que simula e anima estratégias de embarque em um avião, para comparar qual é a mais rápida. Roda inteira no navegador, sem instalação nem servidor.

**Abrir:** https://jcaminha.github.io/plane-boarding/

## O que faz

- **Corrida animada**: cada estratégia escolhida embarca os mesmos passageiros em um avião próprio, lado a lado.
- **Passageiros heterogêneos**: famílias com crianças, casais, pessoas sozinhas e idosos, com velocidades diferentes e bagagem de mão.
- **Oito estratégias prontas**: aleatório, trás para frente, frente para trás, zonas alternadas, janela-meio-corredor, pirâmide invertida, Steffen e Steffen modificado.
- **Estratégias próprias**: pinte grupos de embarque no mapa de assentos ou escreva uma fórmula em JavaScript.
- **Comparação estatística**: roda dezenas de voos com passageiros diferentes para todas as estratégias.

## Rodar localmente

Abra `index.html` no navegador.

## Estrutura

- `js/sim.js`: motor da simulação (sem dependência de navegador; também roda no Node).
- `js/app.js`: interface, animação em canvas, editor de estratégias.
- `css/style.css`: estilos, com tema claro e escuro.

## Sobre o modelo

O corredor é uma fila única em que ninguém ultrapassa ninguém. Quem tem mala bloqueia o corredor enquanto a guarda, e quem precisa passar por um vizinho já sentado espera ele se levantar. Os tempos usados são estimativas, não medições: a ordem relativa entre as estratégias é mais confiável que os minutos absolutos.
