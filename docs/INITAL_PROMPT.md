Last Man Standing

10–50 graczy → rundy → eliminacje → jeden zwycięzca.

Każdy gracz w każdej rundzie wybiera jedną z 3 akcji:

⚔️ Attack — próbujesz wyeliminować kogoś
🛡️ Defend — chronisz się
🏃 Hide — jesteś mniej skuteczny, ale trudniej Cię zaatakować

Nie pokazujesz wyboru innym.

Po zamknięciu rundy następuje reveal.

Przykład

20 graczy:

Player #7 → Attack #13
Player #13 → Attack #7
Player #4 → Defend
Player #9 → Hide

System rozstrzyga.

Po każdej rundzie liczba graczy maleje.

Najważniejszy element

Informacja.

Po każdej rundzie widzisz historię:

#7 → zaatakował #13
#13 → zaatakował #7
#4 → bronił się
#9 → ukrył się

Po 5 rundach zaczynasz rozumieć styl innych graczy.

„#7 zawsze atakuje lidera.”

I możesz to wykorzystać.

Betting

Przed rundą:

Kto zostanie wyeliminowany?

Albo:

Kto będzie w TOP 3?

# Możesz obstawiać konkretnego gracza.

Feature'y do zaimplementowania (nie są to sztywne zasady)
Projekt: Cross-Chain Multiplayer Arena

Prosta gra multiplayer, np. Last Man Standing:

4–8 graczy rywalizuje w krótkich, dynamicznych meczach
WebSocket odpowiada za komunikację realtime między klientem a serwerem
serwer prowadzi authoritative game state off-chain
gracze logują się i identyfikują za pomocą crypto wallet
wejście do meczu i stawka są obsługiwane on-chain
po zakończeniu meczu jego wynik jest synchronizowany z blockchainem
smart contract odpowiada za settlement i wypłatę nagród
gracze mogą uczestniczyć w tym samym meczu z różnych blockchainów
cross-chain messaging synchronizuje informacje o graczach, wpłatach, stanie i wynikach pomiędzy chainami
oracle dostarcza zewnętrzne dane, np. bezpieczną losowość lub ceny aktywów
governance / DAO zarządza parametrami protokołu, np. opłatami, zasadami gry, oracle'ami czy obsługiwanymi chainami
off-chain → on-chain synchronization wykorzystuje podpisy kryptograficzne i relayera do potwierdzania wyników gry
krytyczne, wymagające niskopoziomowej optymalizacji fragmenty smart contractów są napisane w Yul
system zawiera fuzzing, invariant testing i security testing dla smart contractów
całość działa początkowo na testnetach, bez real-money payouts
projekt jest zaprojektowany tak, aby AI coding agents mogły pomagać w implementacji, testowaniu, analizie bezpieczeństwa i rozwijaniu poszczególnych modułów
Główne technologie

TypeScript / Node.js / WebSocket / PixiJS / PostgreSQL / Redis / Solidity / Foundry / Yul / EVM / LayerZero / Chainlink / OpenZeppelin / viem
