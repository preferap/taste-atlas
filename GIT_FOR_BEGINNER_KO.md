# Git 완전 처음 가이드 (아주 쉽게)

## 0. Git이 뭐야?
- Git은 "저장 버튼의 초강화 버전"이야.
- 네가 그림(코드)을 고칠 때마다 "스냅샷"을 찍어둬.
- 나중에 "어제 버전"으로 돌아가거나, "언제 뭘 바꿨는지" 볼 수 있어.

## 1. 준비물
- 네 프로젝트 폴더: `taste-map`
- 터미널 앱
- GitHub 계정 1개

## 2. 폴더로 이동하기
터미널에 아래를 입력:

```bash
cd /Users/hokyoung/preferap/taste-map
```

## 3. Git 시작하기 (처음 1번만)

```bash
git init
```

이 뜻: "여기서부터 스냅샷 찍을게!"

## 4. Git이 안 봐도 되는 파일 정하기
`node_modules` 같은 큰 파일은 스냅샷에서 빼는 게 좋아.

```bash
printf ".DS_Store\nnode_modules\n.next\n.env\n.env.local\n" > .gitignore
```

## 5. 첫 스냅샷 찍기

### 5-1) 지금 상태 확인
```bash
git status
```

### 5-2) 사진 찍을 파일 모으기
```bash
git add .
```

### 5-3) 사진 이름 붙여 저장하기
```bash
git commit -m "init: first version of taste atlas"
```

## 6. GitHub에 새 저장소 만들기
1. GitHub 로그인  
2. `New repository` 클릭  
3. 이름: `taste-atlas` (원하는 이름 가능)  
4. `Create repository` 클릭

## 7. 내 컴퓨터 Git과 GitHub 연결
아래에서 `YOUR_ID`는 네 GitHub 아이디로 바꿔:

```bash
git branch -M main
git remote add origin https://github.com/YOUR_ID/taste-atlas.git
git push -u origin main
```

성공하면 GitHub에 코드가 올라간다.

## 8. 앞으로의 반복 루틴 (매일 하는 3줄)
코드 수정 후:

```bash
git add .
git commit -m "feat: what changed"
git push
```

## 9. 자주 쓰는 명령어
- 상태 보기: `git status`
- 히스토리 보기: `git log --oneline`
- 원격 저장소 확인: `git remote -v`

## 10. 실수해도 괜찮아
- Git은 실수 대비용 도구야.
- 중요한 건 자주 커밋하는 습관이야.
