# Temps d'attente aux frontières Canada / États-Unis

Intégration non officielle, sans lien avec l'Agence des services frontaliers du
Canada (ASFC) ni avec le U.S. Customs and Border Protection (CBP). Elle lit les
**temps d'attente aux postes frontaliers terrestres entre le Canada et les
États-Unis**, dans les deux sens, à partir des données ouvertes des deux
agences : pas de compte, pas de clé.

- **Vers le Canada** : fichier de l'ASFC (`bwt-eng.csv`, et `bwt-fra.csv` pour
  les noms en français), attente des voyageurs et des véhicules commerciaux.
- **Vers les États-Unis** : flux du CBP (`bwt.cbp.gov`), attente des véhicules
  de tourisme, des voies NEXUS et Ready Lane, des véhicules commerciaux et des
  voies FAST. Seule la frontière canadienne est gardée.

**Lecture seule** : rien n'est jamais envoyé aux agences, à part des requêtes
GET. Essayée contre les vrais fichiers de l'ASFC et du CBP le 29 octobre 2026 ;
le module n'a pas encore été utilisé dans une vraie installation Gladys par
un voyageur : dites-nous ce que vous voyez.

Les temps affichés sont des **estimations publiées par les agences**, à titre
indicatif : ils peuvent changer vite et ne remplacent pas les informations
officielles.

## Installation

1. Installez l'intégration, choisissez la langue des noms et l'intervalle de
   lecture (de 10 à 60 minutes, 15 par défaut), puis enregistrez.
2. La première lecture part aussitôt (ou à l'intervalle après la précédente
   si le conteneur vient de redémarrer). Ouvrez l'onglet **Découverte** :
   chaque passage y apparaît deux fois au plus, un appareil par sens
   (« Vers le Canada : … » et « Vers les États-Unis : … »).
3. Créez les passages qui vous intéressent.

## Ce que vous obtenez

| Appareil            | Fonction                      | Unité |
| ------------------- | ----------------------------- | ----- |
| Vers le Canada      | Attente voyageurs             | min   |
| Vers le Canada      | Attente véhicules commerciaux | min   |
| Vers les États-Unis | Attente véhicules de tourisme | min   |
| Vers les États-Unis | Attente NEXUS                 | min   |
| Vers les États-Unis | Attente Ready Lane            | min   |
| Vers les États-Unis | Attente véhicules commerciaux | min   |
| Vers les États-Unis | Attente FAST                  | min   |
| Les deux            | État                          | texte |

Une voie que le passage n'a pas ne reçoit simplement jamais de valeur.

- « No Delay » (ASFC) et « no delay » (CBP) valent **0 minute** : c'est une
  attente nulle annoncée par l'agence.
- « Closed », « Not Applicable », « -- », « Lanes Closed », « Update Pending »,
  « N/A » ou un texte inconnu ne sont **jamais publiés comme un nombre** : la
  fonction **État** le dit (« Fermé », « Voies fermées », « Mise à jour en
  attente à la source », « Sans objet pour ce passage », « Pas de mesure
  publiée par la source », « Valeur illisible : rien publié »).
- L'état donne aussi l'heure du relevé : celle de l'ASFC avec son fuseau
  (ex. `2026-10-29 16:40 EDT`), celle du CBP en heure locale du poste.

## Fraîcheur

- Chaque relevé n'est publié qu'**une fois** (dédoublonné sur l'heure donnée
  par la source, gardée dans /data) : une scène « attente sous X minutes »
  part donc sur un nouveau relevé, pas à chaque lecture.
- Un relevé de **plus de 2 heures** (âge compté comme ci-dessous) n'est jamais publié ; l'état devient
  « Relevé périmé (plus de 2 h) » avec son heure. L'âge se compte depuis l'en-tête
  `Date` du serveur (ASFC) ou l'heure locale du poste (CBP).
- Le flux du CBP indique l'heure de chaque poste : s'il ne bouge plus pendant
  plus de 2 heures, plus rien n'en est publié et l'état devient « Source muette
  depuis plus de 2 h : rien publié ».
- Le CBP saisit le fuseau à la main (on y voit « EST » en octobre) : il n'est
  pas utilisé, l'heure est lue comme l'heure locale du poste, la veille si elle
  est plus tard que l'heure du poste.
- Gladys garde la dernière valeur publiée d'une fonction : quand une attente
  n'est plus connue, c'est la fonction **État** qui le dit, pas la valeur.

## Déclencher une scène « attente sous X minutes »

Dans une scène, choisissez le déclencheur **Changement d'état de l'appareil**,
la fonction d'attente voulue et la condition « inférieur à X ». Elle part au
premier relevé frais sous X.

## Rythme et sources

- Une lecture toutes les N minutes (10 à 60), jamais plus souvent :
  enregistrer le formulaire, une reconnexion, l'onglet Découverte, un appareil
  créé ou un redémarrage ne relancent aucune lecture (l'heure de la dernière
  tentative est écrite dans /data avant chaque lecture). Seule exception : un
  redémarrage alors que /data n'a pu être lu ou écrit, qui lit aussitôt.
- Une requête à la fois : l'ASFC en anglais, l'ASFC en français (seulement si
  la langue est le français, pour les noms), puis le CBP. Chaque requête est
  bornée à 20 secondes et en taille (256 Ko pour l'ASFC, 4 Mo pour le CBP).
- L'ASFC reçoit les en-têtes `If-None-Match` / `If-Modified-Since` qu'elle
  propose ; le CBP n'en propose pas.
- User-Agent : `gladys-attente-frontiere/<version> (+adresse du dépôt)`.
- Une réponse 429 ou 5xx met **cette source** en pause (5 minutes doublées à
  chaque échec, `Retry-After` respecté, entre 60 secondes et 6 heures), pause
  gardée au redémarrage. L'autre source continue d'être lue.
- Les noms français de l'ASFC ne bloquent jamais rien : sans eux, les noms
  anglais sont utilisés.

## Statut de l'intégration

« Connecté » dès qu'au moins une des deux sources a été lue à sa dernière
tentative (le CBP ne compte que si son flux bouge encore) ; avant la première
lecture, « En attente de la première lecture (dans N min) ». Le message dit pour chaque
source ce qui ne va pas : injoignable, pas de réponse à temps, pause après un
429 ou un 5xx, format inattendu, flux figé ; et aussi un intervalle remplacé
(hors 10-60 minutes), un /data illisible (mis de côté sous un autre nom) ou non
inscriptible, des valeurs reportées à la lecture suivante (Gladys accepte 300
états par minute, le module en envoie 250 au plus).

## Données et licences

- Contient des informations visées par la **Licence du gouvernement ouvert –
  Canada** (ASFC, jeu de données « Temps d'attente actuels à la frontière »).
- Les données du CBP sont une œuvre du gouvernement des États-Unis, dans le
  domaine public.
- Aucune donnée personnelle n'est lue ni gardée.
