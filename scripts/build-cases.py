#!/usr/bin/env python3
"""Build an offline six-code case index from the KGraphNavi RDF release."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unicodedata
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'docs' / 'data'
RELEASE = 'caselaw-data-2026.10'
ARCHIVE = 'hanrei_public.ttl.gz'
SHA256 = 'f4bed5322dc982b9ed463a925d3178524c7ccd33f3d0c7b8a6919c1a3989e278'
UPSTREAM = 'https://github.com/JurisInformaticsCenter/KGraphNavi/releases'
COURTS = 'https://www.courts.go.jp'
LAW_NAMES = {
    '日本国憲法': 'constitution', '憲法': 'constitution',
    '民事訴訟法': 'civil-procedure', '民訴法': 'civil-procedure', '民事訴訟': 'civil-procedure', '民訴': 'civil-procedure',
    '刑事訴訟法': 'criminal-procedure', '刑訴法': 'criminal-procedure', '刑事訴訟': 'criminal-procedure', '刑訴': 'criminal-procedure',
    '民法': 'civil', '商法': 'commercial', '刑法': 'criminal',
}
NUMBERS = dict(zip('〇一二三四五六七八九', range(10)))
UNITS = {'千': 1000, '百': 100, '十': 10}
NUMBER = '[0-9〇零一二三四五六七八九十百千]+'
OFFICIAL_REF = re.compile(
    rf"(?<!旧)(?<!改正前)({'|'.join(LAW_NAMES)})\s*第?({NUMBER})[条條]((?:[のノ]{NUMBER})*)"
)
RESOURCE = re.compile(r'^caselaw:([DJT])(\d{6})\s*$')
ISSUE_RESOURCE = re.compile(r'^caselaw:I(\d{6})_\d+ a caselawo:Issue')
REFERENCE = re.compile(r'^caselaw:D(\d{6}) caselawp:(reflawCore|reflaw) law:([A-Z0-9]+)_(\d+(?:-\d+)*)(?:_[\w-]+)?\s*\.')
RDF_PROPERTY = re.compile(r'^\s*(?:<http://ds\.rois\.ac\.jp/caselaw/property/([^>]+)>|((?:rdfs|caselawp|foaf):\S+))\s+(.*)$')
LITERAL = re.compile(r'^"((?:[^"\\]|\\.)*)"')
PDF = re.compile(r'^<https://www\.courts\.go\.jp/assets/hanrei/hanrei-pdf-\d+\.pdf>')
JUDGMENT_FIELDS = {'judgmentdate', '裁判要旨', '判示事項の要旨', '判示事項', '参照法条', 'disposition_meta', '裁判種別'}
TRIAL_FIELDS = {'court', '部名', 'caseno', 'casename'}


def read_literal(raw):
    match = LITERAL.match(raw)
    if not match:
        return ''
    try:
        return json.loads('"' + match.group(1) + '"').strip()
    except ValueError:
        return match.group(1).strip()


def unpack_number(value):
    value = value.replace('零', '〇')
    if any(char in UNITS for char in value):
        result = 0
        digits = ''
        for char in value:
            if char in UNITS:
                result += int(digits or '1') * UNITS[char]
                digits = ''
            else:
                digits += str(NUMBERS.get(char, char))
        return str(result + int(digits or '0'))
    return str(int(''.join(str(NUMBERS.get(char, char)) for char in value)))


def read_laws():
    with (DATA / 'catalog.json').open(encoding='utf-8') as file:
        catalog = json.load(file)
    by_id = {}
    current = {}
    for law in catalog['laws']:
        by_id[law['officialId']] = law['id']
        with (DATA / (law['id'] + '.json')).open(encoding='utf-8') as file:
            article_data = json.load(file)['articles']
        current[law['id']] = {
            article['id'] for article in article_data
            if re.fullmatch(r'\d+(?:_\d+)*', article['id'])
        }
    return by_id, current


def read_graph(path, by_id, current):
    refs = defaultdict(dict)
    metadata = defaultdict(dict)
    issues = defaultdict(list)
    group = case_id = None
    issue = None
    with gzip.open(path, mode='rt', encoding='utf-8') as graph:
        for line in graph:
            if line.startswith('caselaw:D') and ' caselawp:reflaw' in line[:43]:
                match = REFERENCE.match(line)
                if match:
                    key, kind, official_id, article = match.groups()
                    law_id = by_id.get(official_id)
                    article_id = article.replace('-', '_')
                    if law_id and article_id in current[law_id]:
                        rank = 2 if kind == 'reflawCore' else 1
                        pair = (law_id, article_id)
                        refs[key][pair] = max(rank, refs[key].get(pair, 0))
                continue

            if line.startswith('caselaw:') and line[8:9] in {'D', 'J', 'T', 'I'}:
                if line[8] == 'I':
                    match = ISSUE_RESOURCE.match(line)
                    if match:
                        group, case_id = 'I', match[1]
                        issue = {}
                        issues[case_id].append(issue)
                        continue
                elif len(line.rstrip()) == 15:
                    match = RESOURCE.match(line)
                    if match:
                        group, case_id = match.groups()
                        continue

            if group and line[:1] in (' ', '\t'):
                if group == 'I' and not any(field in line[:42] for field in ('rdfs:label', 'caselawp:judged', 'caselawp:issueOutcomeText')):
                    continue
                match = RDF_PROPERTY.match(line)
                if not match:
                    continue
                field = match[1] or match[2]
                raw = match[3]
                if group == 'D' and field == 'foaf:primaryTopic':
                    match = PDF.match(raw)
                    if match:
                        metadata[case_id]['pdf'] = match[0][1:-1]
                elif group == 'D' and field == 'rdfs:label':
                    metadata[case_id]['label'] = read_literal(raw)
                elif (group == 'J' and field in JUDGMENT_FIELDS) or (group == 'T' and field in TRIAL_FIELDS):
                    value = raw.split('caselawo:', 1)[1].rstrip(';. ') if raw.startswith('caselawo:') else read_literal(raw)
                    if value:
                        metadata[case_id].setdefault(field, value)
                elif group == 'I' and field in ('rdfs:label', 'caselawp:judged', 'caselawp:issueOutcomeText'):
                    value = (raw.startswith('true') if field == 'caselawp:judged' else read_literal(raw))
                    issue[field] = value
            else:
                group = None
    return refs, metadata, issues


def official_references(row, current):
    text = unicodedata.normalize('NFKC', row.get('参照法条', ''))
    date = row.get('judgmentdate', '')
    for match in OFFICIAL_REF.finditer(text):
        law_id = LAW_NAMES[match[1]]
        if law_id == 'civil-procedure' and date < '1998-01-01':
            continue
        if law_id == 'criminal-procedure' and date < '1949-01-01':
            continue
        number = '_'.join(unpack_number(n) for n in [match[2]] + re.findall(NUMBER, match[3]))
        if number in current[law_id]:
            yield law_id, number


def short_text(value, limit):
    text = re.sub(r'\s+', ' ', value).strip()
    if len(text) <= limit:
        return text
    cutoff = text.rfind('。', 0, limit)
    return text[:cutoff + 1] if cutoff >= limit // 2 else text[:limit] + '…'


def case_summary(row, issues):
    for field, label in [
        ('裁判要旨', '裁判所の裁判要旨'),
        ('判示事項の要旨', '裁判所の判示事項の要旨'),
        ('判示事項', '裁判所の判示事項'),
    ]:
        if row.get(field):
            return short_text(row[field], 600), label
    for issue in issues:
        excerpt = issue.get('caselawp:issueOutcomeText', '')
        if excerpt and issue.get('caselawp:judged'):
            return short_text(excerpt, 350), '判決理由から自動抽出'
    title = row.get('casename') or row.get('label') or '裁判例'
    disposition = row.get('disposition_meta')
    summary = f'事件名は「{title}」です。'
    if disposition:
        summary += f'裁判所が公開した裁判結果は「{disposition}」です。'
    return summary, '事件情報'


def selection_order(case):
    return case['summaryKind'] == '編集要約', case['date'], case['id']


def curated_cases():
    for case in json.loads((ROOT / 'scripts' / 'featured-cases.json').read_text(encoding='utf-8')):
        yield case['id'], case


def case_body(url, work):
    if not shutil.which('pdftotext'):
        raise RuntimeError('pdftotext is required to rebuild the selected offline decisions.')
    pdf_path = work / 'judgment.pdf'
    with urlopen(url, timeout=35) as remote, pdf_path.open('wb') as output:
        shutil.copyfileobj(remote, output)
    result = subprocess.run(['pdftotext', '-enc', 'UTF-8', '-nopgbrk', str(pdf_path), '-'], capture_output=True, check=True)
    text = result.stdout.decode().strip()
    text = re.sub(r'(?m)^\s*-\s*\d+\s*-\s*$', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    if len(re.sub(r'[^一-龯ぁ-ゖァ-ヺ]', '', text)) < 100:
        return ''
    return text


def write_json(path, data):
    with path.open('w', encoding='utf-8') as file:
        json.dump(data, file, ensure_ascii=False, separators=(',', ':'))
        file.write('\n')


def write_shards(output, metadata, cases):
    limit = 1_350_000
    by_law = defaultdict(lambda: defaultdict(list))
    case_sizes = {}
    for index, case in enumerate(cases):
        case_sizes[index] = len(json.dumps(case, ensure_ascii=False, separators=(',', ':')).encode()) + 1
        for link in case['articles']:
            by_law[link['law']][link['id']].append(index)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='case-shards-', dir=output.parent) as staging:
        staged = Path(staging)
        shard_map = {}
        for law, article_map in by_law.items():
            shard_map[law] = law_shards(staged, law, article_map, cases, case_sizes, limit)
        write_json(staged / 'index.json', {**metadata, 'count': len(cases), 'shards': shard_map})

        output.mkdir(exist_ok=True)
        for shard in sorted(staged.glob('*.json'), key=lambda path: path.name == 'index.json'):
            shard.replace(output / shard.name)
        keep = {name for law_shard in shard_map.values() for name in law_shard.values()}
        keep.add('index.json')
        for old in output.glob('*.json'):
            if old.name not in keep:
                old.unlink()


def law_shards(output, law, article_map, cases, case_sizes, limit):
    positions = sorted(article_map, key=lambda article: tuple(map(int, article.split('_'))))
    lookup = {}
    bucket_articles = []
    bucket_cases = set()
    bucket_size = 0

    def write_bucket():
        name = f'{law}-{bucket_articles[0]}.json'
        write_json(output / name, {'cases': [cases[i] for i in sorted(bucket_cases)]})
        for article_id in bucket_articles:
            lookup[article_id] = name

    for article_id in positions:
        article_indices = set(article_map[article_id])
        new_indices = article_indices - bucket_cases
        new_size = sum(case_sizes[i] for i in new_indices)
        if bucket_articles and bucket_size + new_size > limit:
            write_bucket()
            bucket_articles = []
            bucket_cases = set()
            bucket_size = 0
            new_indices = article_indices
            new_size = sum(case_sizes[i] for i in new_indices)

        bucket_articles.append(article_id)
        bucket_cases.update(new_indices)
        bucket_size += new_size
    if bucket_articles:
        write_bucket()
    return lookup


def build(archive, output, work):
    by_id, current = read_laws()
    refs, metadata, issues = read_graph(archive, by_id, current)
    featured = dict(curated_cases())
    for key, row in metadata.items():
        for pair in official_references(row, current):
            refs[key][pair] = 3
    for key, case in featured.items():
        for link in case.get('articles', []):
            pair = (link['law'], link['id'])
            if pair[1] not in current[pair[0]]:
                raise ValueError(f'Unknown article for featured decision {key}: {pair}')
            refs[key][pair] = 4
    cases = []
    relations = {1: '判決文の参照（自動抽出）', 2: '判断に登場（自動抽出）', 3: '裁判所の参照法条', 4: '現行法の対応条文（編集）'}
    for key, pairs in refs.items():
        row = metadata.get(key, {})
        pdf = row.get('pdf')
        date = row.get('judgmentdate')
        if not pairs or not pdf or not date:
            continue
        summary, summary_kind = case_summary(row, issues.get(key, []))
        case = {
            'id': key,
            'title': row.get('label') or row.get('casename') or '裁判例',
            'court': ''.join(row[field] for field in ('court', '部名') if row.get(field)),
            'date': date,
            'summary': summary,
            'summaryKind': summary_kind,
            'source': pdf,
            'articles': [],
        }
        if key in featured:
            case.update({field: featured[key][field] for field in ('title', 'summary')})
            case['summaryKind'] = '編集要約'
            case['source'] = f'{COURTS}/hanrei/{int(key)}/detail2/index.html'
            case['pdf'] = pdf
            body = case_body(pdf, work)
            if body:
                case['body'] = body
        for (law, article), rank in sorted(pairs.items()):
            case['articles'].append({'law': law, 'id': article, 'relation': relations[rank]})
        cases.append(case)
    cases.sort(key=selection_order, reverse=True)
    present = {case['id'] for case in cases}
    if missing := featured.keys() - present:
        raise ValueError(f'Missing featured decisions: {sorted(missing)}')
    if len(cases) < 10_000:
        raise ValueError(f'Expected a broad case index but extracted only {len(cases)} records')
    coverage = (
        '裁判所が公開した裁判例から、六法の現行条番号と対応付けられた裁判例を収録。'
        '判決文中の参照には当事者の主張なども含まれます。自動抽出には誤りや漏れがあり、'
        '古い判決の条文は当時の規定で確認してください。裁判所の検索システム自体にも未掲載の裁判例があります。'
    )
    result = {
        'coverage': coverage,
        'snapshot': '2026-10-01',
        'attribution': {
            'name': '情報・システム研究機構 人工知能法学研究センター「日本の判例の知識グラフ」',
            'url': f'{UPSTREAM}/tag/{RELEASE}',
            'license': 'CC BY 4.0',
            'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'changes': '六法の条文との関係・事件情報を抽出し、要旨を一部短縮。選定例には編集要約を追加。',
        },
    }
    write_shards(output, result, cases)
    sizes = [p.stat().st_size for p in output.glob('*.json')]
    print('Cases:', len(cases), 'shards:', len(sizes)-1, 'total bytes:', sum(sizes), 'largest file:', max(sizes))
    print('Summary coverage:', Counter(case['summaryKind'] for case in cases))
    print('Law matches:', Counter(link['law'] for case in cases for link in case['articles']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Use a local copy of the pinned release archive')
    parser.add_argument('--output', type=Path, default=DATA / 'cases', help='Directory for the case index and shards')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='unicode-case-index-') as path:
        work = Path(path)
        archive = args.archive
        if not archive:
            archive = work / ARCHIVE
            with urlopen(f'{UPSTREAM}/download/{RELEASE}/{ARCHIVE}', timeout=90) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        with archive.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != SHA256:
            raise ValueError(f'The SHA-256 hash does not match the pinned {RELEASE} release')
        build(archive, args.output, work)


if __name__ == '__main__':
    main()
