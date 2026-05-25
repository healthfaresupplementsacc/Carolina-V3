/* Entry point — só carrega CSS e dispara o App (que se auto-renderiza no #root).
   ESM (E0): styles primeiro, depois App. A ordem dos CSS importa porque
   `timeline.css` e `extras.css` sobrescrevem tokens definidos em `styles.css`.
*/
import './styles.css';
import './timeline.css';
import './extras.css';
import './App.jsx';
