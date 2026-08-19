/* MiniCalendar — grade de mês, PT-BR, com marca nos dias que têm coisa.
   (Bruno 08-19: "quero um mini calendário onde eu clico e escolho a data que
   eu quero revisar".)

   Genérico de propósito: ele não sabe o que é revisão. Recebe `marks` (mapa
   'YYYY-MM-DD' → {n, label}) e pinta um ponto no dia; quem chama decide o que
   o ponto significa. Serve pro painel de Revisão hoje e pra qualquer outra
   tela de "escolha um dia" amanhã.

   DATAS SÃO STRING, NÃO Date. O sistema inteiro trabalha no dia de NY; se eu
   construísse `new Date(ymd)` pra montar a grade, o fuso do navegador puxaria
   o dia pra trás ou pra frente e o calendário mostraria um dia diferente do
   que o backend contou. Toda a aritmética aqui é feita em Date UTC e só a
   string YYYY-MM-DD atravessa a fronteira.

   API:
     <MiniCalendar
       month="2026-08"          mês visível (controlado)
       onMonth={fn}             pediu outro mês (prev/next/navegação por seta)
       selected="2026-08-17"    dia selecionado
       today="2026-08-19"       qual dia é "hoje" (NY, vem de fora)
       marks={{ '2026-08-17': { n: 3 } }}
       onPick={fn(ymd)}         escolheu um dia
       loading={bool}           mostra o mês esmaecido enquanto carrega
     />
*/
import React from 'react';
import { Icon } from './Icons.jsx';

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const parse = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +(s.slice(8, 10) || '01')));
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const monthOf = (s) => (s || '').slice(0, 7);

/** Título por extenso: "segunda-feira, 17 de agosto de 2026". */
export function longDate(s) {
  if (!s) return '';
  const d = parse(s);
  const wd = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
    'quinta-feira', 'sexta-feira', 'sábado'][d.getUTCDay()];
  return `${wd}, ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

/** Curto: "17/08". */
export const shortDate = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '');

/** Grade de 6 semanas cobrindo o mês (com os dias vizinhos pra fechar a linha). */
function gridOf(month) {
  const first = parse(month + '-01');
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const out = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(ymd(d));
  }
  return out;
}

export function MiniCalendar({
  month, onMonth, selected, today, marks = {}, onPick, loading = false,
}) {
  const m = month || monthOf(selected) || monthOf(today) || '2026-01';
  const days = React.useMemo(() => gridOf(m), [m]);
  const gridRef = React.useRef(null);

  const shift = (n) => {
    const next = addDays(selected || today || m + '-01', n);
    if (monthOf(next) !== m && onMonth) onMonth(monthOf(next));
    if (onPick) onPick(next);
  };

  /* Setas do teclado andam de dia em dia (e viram o mês sozinhas), Enter/Espaço
     confirmam. Sem isso o calendário é um brinquedo de mouse. */
  const onKeyDown = (e) => {
    const map = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (map[e.key] != null) { e.preventDefault(); shift(map[e.key]); return; }
    if (e.key === 'PageUp') { e.preventDefault(); onMonth && onMonth(stepMonth(m, -1)); return; }
    if (e.key === 'PageDown') { e.preventDefault(); onMonth && onMonth(stepMonth(m, 1)); }
  };

  return (
    <div className="mini-cal" data-mini-cal onKeyDown={onKeyDown} ref={gridRef}>
      <div className="mini-cal-head">
        <button className="kit-btn xs" data-cal-prev aria-label="Mês anterior"
                onClick={() => onMonth && onMonth(stepMonth(m, -1))}>
          <Icon name="left" size={12}/>
        </button>
        <b className="mini-cal-title">
          {MONTHS[+m.slice(5, 7) - 1]} <span className="mono">{m.slice(0, 4)}</span>
        </b>
        <button className="kit-btn xs" data-cal-next aria-label="Próximo mês"
                onClick={() => onMonth && onMonth(stepMonth(m, 1))}>
          <Icon name="right" size={12}/>
        </button>
      </div>

      <div className="mini-cal-wd">
        {WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}
      </div>

      <div className={'mini-cal-grid' + (loading ? ' loading' : '')}>
        {days.map((d) => {
          const out = monthOf(d) !== m;
          const mk = marks[d];
          const isSel = d === selected;
          return (
            <button key={d} type="button"
                    data-cal-day={d}
                    className={'mini-cal-day'
                      + (out ? ' out' : '')
                      + (isSel ? ' sel' : '')
                      + (d === today ? ' today' : '')
                      + (mk ? ' has' : '')}
                    aria-pressed={isSel}
                    title={mk ? `${mk.n} revisão(ões) em ${shortDate(d)}` : shortDate(d)}
                    onClick={() => onPick && onPick(d)}>
              <span>{+d.slice(8, 10)}</span>
              {mk ? <i className="mini-cal-dot" aria-hidden="true"/> : null}
            </button>
          );
        })}
      </div>

      <div className="mini-cal-foot">
        <button className="kit-btn xs" data-cal-today
                onClick={() => {
                  if (!today) return;
                  if (monthOf(today) !== m && onMonth) onMonth(monthOf(today));
                  onPick && onPick(today);
                }}>Hoje</button>
        <span className="kit-mlabel">setas andam de dia · PgUp/PgDn troca o mês</span>
      </div>
    </div>
  );
}

function stepMonth(m, n) {
  const d = parse(m + '-01');
  d.setUTCMonth(d.getUTCMonth() + n);
  return ymd(d).slice(0, 7);
}

export default MiniCalendar;
