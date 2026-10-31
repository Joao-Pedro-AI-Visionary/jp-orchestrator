# Decisões de UX do painel

Leis de UX aplicadas e onde aparecem.

- Fitts: todo alvo interativo tem no mínimo 48px (botões, filtros, checkbox 24px dentro de linha de 48px); fechar aviso tem 44px.
- Hick: apenas 4 filtros de tarefa; a caixa de aprovação e o campo de observação só surgem quando a tarefa aguarda aprovação (divulgação progressiva).
- Jakob: layout convencional de dashboard (cabeçalho com marca à esquerda e CTA à direita, KPIs, lista e detalhe, painéis).
- Proximidade e Conectividade Uniforme: informações relacionadas ficam no mesmo card; a linha do tempo de contexto é uma linha vertical contínua ligando os snapshots.
- Miller: a linha de KPIs é limitada a 5 indicadores.
- Doherty: skeletons durante o carregamento, estados pressionados (escala) imediatos, alternância de modelo otimista e atualização por eventos ao vivo em menos de 400ms.
- Von Restorff: somente o CTA "Nova tarefa" usa o acento da marca; demais ações são neutras.
- Pico-Fim: tarefa concluída exibe um banner de conclusão com resumo, artefatos e custo final.
- Tesler: os 3 modelos de tarefa preenchem o formulário inteiro, sem o usuário precisar digitar.
- Gradiente de Meta: "3 de 4 concluídos" com barra de progresso das subtarefas.

Acessibilidade: landmarks (header, main, footer, sections nomeadas), região aria-live para eventos, foco visível, texto com contraste mínimo de 4.5:1, rótulos em botões de ícone e `prefers-reduced-motion` respeitado (animações em loop desligadas).
